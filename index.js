// === IMPORTS ===
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";

// === TELEGRAM CONFIG ===
const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN not set");

const bot = new TelegramBot(token, { polling: false });

// === Graceful shutdown ===
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`🧹 Graceful shutdown (${signal})...`);
  saveState();
  console.log("✅ Shutdown complete");
  process.exit(0);
}

process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("unhandledRejection", (reason, promise) => {
  console.error("⚠️ Unhandled Rejection:", reason);
});

const CHANNEL = "xposure_tracks_arena";
const MAIN_CHANNEL = "xposuretoken";

// === SOLANA CONFIG ===
const RPC_URL = process.env.SOLANA_RPC_URL;
if (!RPC_URL) {
  throw new Error("❌ SOLANA_RPC_URL environment variable required!");
}
const connection = new Connection(RPC_URL, "confirmed");

// === WALLET ADDRESSES ===
const TREASURY = new PublicKey("98tf4zU5WhLmsCt1D4HQH5Ej9C5aFwCz8KQwykmKvDDQ");
const TRANS_FEE_WALLET = new PublicKey("CDfvckc6qBqBKaxXppPJrhkbZHHYvjVw2wAFjM38gX4B");
const TOKEN_MINT = new PublicKey("G2NBQ9fUeQEDdTpYzp68d7DePKY4vEUmNYP2kYZHpump");

const TREASURY_PRIVATE_KEY = process.env.BOT_PRIVATE_KEY
  ? Uint8Array.from(JSON.parse(process.env.BOT_PRIVATE_KEY))
  : null;
if (!TREASURY_PRIVATE_KEY) throw new Error("❌ BOT_PRIVATE_KEY missing!");
const TREASURY_KEYPAIR = Keypair.fromSecretKey(TREASURY_PRIVATE_KEY);

// === STATE ===
let treasuryXPOSURE = 0;  // Current round prize pool (resets each round)
let actualTreasuryBalance = 0;  // REAL treasury balance (grows perpetually)
let transFeeCollected = 0;
let pendingPayments = [];
let participants = [];
let voters = [];
let phase = "submission";
let cycleStartTime = null;
let nextPhaseTime = null;

// === TREASURY PRIZE SYSTEM ===
const TREASURY_BONUS_CHANCE = 500; // 1 in 500 chance

// Dynamic treasury bonus percentage based on ACTUAL treasury size
function getTreasuryBonusPercentage() {
  if (actualTreasuryBalance < 100000) return 0.20;      // 20% for small treasury (< 100k)
  if (actualTreasuryBalance < 500000) return 0.15;      // 15% for medium treasury (100k-500k)
  if (actualTreasuryBalance < 1000000) return 0.10;     // 10% for large treasury (500k-1M)
  if (actualTreasuryBalance < 5000000) return 0.05;     // 5% for very large treasury (1M-5M)
  return 0.02;                                          // 2% for mega treasury (5M+)
}

// === CHECK FOR TREASURY BONUS WIN ===
function checkTreasuryBonus() {
  const roll = Math.floor(Math.random() * TREASURY_BONUS_CHANCE) + 1;
  return roll === 1; // 1 in 500 chance
}

// === CALCULATE POTENTIAL TREASURY BONUS ===
function calculateTreasuryBonus() {
  const percentage = getTreasuryBonusPercentage();
  return Math.floor(actualTreasuryBalance * percentage);
}

// === GET ACTUAL TREASURY BALANCE FROM BLOCKCHAIN ===
async function getActualTreasuryBalance() {
  try {
    const treasuryTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      TREASURY
    );
    
    const balance = await connection.getTokenAccountBalance(treasuryTokenAccount);
    const xposureBalance = Math.floor(parseFloat(balance.value.uiAmount || 0));
    
    console.log(`🏦 Treasury wallet balance: ${xposureBalance.toLocaleString()} XPOSURE`);
    return xposureBalance;
  } catch (err) {
    console.log(`⚠️ Could not fetch treasury balance: ${err.message}`);
    return actualTreasuryBalance; // Return current tracked value as fallback
  }
}

// === CALCULATE VOTING TIME ===
function calculateVotingTime() {
  const uploaders = participants.filter(p => p.choice === "upload" && p.track);
  
  if (uploaders.length === 0) {
    return 3 * 60 * 1000; // Default 3 minutes if no tracks
  }
  
  let totalDuration = 0;
  let hasAllDurations = true;
  
  for (const uploader of uploaders) {
    if (uploader.trackDuration && uploader.trackDuration > 0) {
      totalDuration += uploader.trackDuration;
    } else {
      hasAllDurations = false;
    }
  }
  
  if (hasAllDurations && totalDuration > 0) {
    // Use actual durations + 1 minute for decision time
    const votingTime = (totalDuration + 60) * 1000; // Convert to milliseconds
    console.log(`⏱️ Voting time: ${Math.ceil(votingTime / 60000)} minutes (based on track durations)`);
    return votingTime;
  } else {
    // Fallback: 2 minutes per track
    const fallbackTime = uploaders.length * 2 * 60 * 1000;
    console.log(`⏱️ Voting time: ${Math.ceil(fallbackTime / 60000)} minutes (fallback: 2 min per track)`);
    return fallbackTime;
  }
}

// === TIER CONFIGURATION ===
const TIERS = {
  BASIC: { 
    min: 0.01, 
    max: 0.049,
    retention: 0.50,
    multiplier: 1.0,
    name: "Basic",
    badge: "🎤"
  },
  MID: { 
    min: 0.05, 
    max: 0.099,
    retention: 0.55,
    multiplier: 1.05,
    name: "Mid Tier",
    badge: "💎"
  },
  HIGH: { 
    min: 0.10, 
    max: 0.499,
    retention: 0.60,
    multiplier: 1.10,
    name: "High Tier",
    badge: "👑"
  },
  WHALE: { 
    min: 0.50,
    max: 999,
    retention: 0.65,
    multiplier: 1.15,
    name: "Whale",
    badge: "🐋"
  }
};

function getTier(amount) {
  if (amount >= TIERS.WHALE.min) return TIERS.WHALE;
  if (amount >= TIERS.HIGH.min) return TIERS.HIGH;
  if (amount >= TIERS.MID.min) return TIERS.MID;
  return TIERS.BASIC;
}

function getWhaleRetention(amount) {
  if (amount < 0.50) return 0.65;
  if (amount >= 5.00) return 0.75;
  return 0.65 + ((amount - 0.50) / 4.50) * 0.10;
}

function getWhaleMultiplier(amount) {
  if (amount < 0.50) return 1.15;
  if (amount >= 5.00) return 1.50;
  return 1.15 + ((amount - 0.50) / 4.50) * 0.35;
}

// === TRANSFER TOKENS TO RECIPIENT ===
async function transferTokensToRecipient(tokenAmount, recipientWallet) {
  try {
    console.log(`📤 Initiating token transfer...`);
    
    const recipientPubkey = new PublicKey(recipientWallet);
    
    // Get treasury token account
    const treasuryTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      TREASURY_KEYPAIR.publicKey
    );
    
    // Get or create recipient token account
    const recipientTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      recipientPubkey
    );
    
    // Check if recipient ATA exists
    const recipientATA = await connection.getAccountInfo(recipientTokenAccount);
    
    const tx = new Transaction();
    
    // Create recipient ATA if needed
    if (!recipientATA) {
      console.log("📝 Creating recipient token account...");
      tx.add(
        createAssociatedTokenAccountInstruction(
          TREASURY_KEYPAIR.publicKey,
          recipientTokenAccount,
          recipientPubkey,
          TOKEN_MINT
        )
      );
    }
    
    // Add transfer instruction
    // Convert XPOSURE amount to raw amount (multiply by 1,000,000 for 6 decimals)
    const rawAmount = Math.floor(tokenAmount * 1_000_000);
    
    tx.add(
      createTransferInstruction(
        treasuryTokenAccount,
        recipientTokenAccount,
        TREASURY_KEYPAIR.publicKey,
        rawAmount  // Use raw amount with 6 decimals
      )
    );
    
    tx.feePayer = TREASURY_KEYPAIR.publicKey;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    
    console.log("✍️ Signing transfer transaction...");
    const sig = await connection.sendTransaction(tx, [TREASURY_KEYPAIR]);
    
    console.log(`📤 Transfer sent: ${sig.substring(0, 8)}...`);
    console.log(`🔗 https://solscan.io/tx/${sig}`);
    
    await connection.confirmTransaction(sig, "confirmed");
    
    console.log(`✅ Transfer confirmed!`);
    
    return true;
    
  } catch (err) {
    console.error(`❌ Token transfer failed: ${err.message}`);
    console.error(err.stack);
    return false;
  }
}

// === CHECK IF TOKEN HAS BONDED ===
async function checkIfBonded() {
  try {
    console.log("🔍 Checking if XPOSURE has graduated from pump.fun...");
    
    const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    
    // Derive bonding curve PDA
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), TOKEN_MINT.toBuffer()],
      PUMP_PROGRAM
    );
    
    const accountInfo = await connection.getAccountInfo(bondingCurve);
    
    if (!accountInfo) {
      console.log("✅ Token has graduated to Raydium! Using Jupiter...");
      return true;
    }
    
    // Check if bonding curve is complete
    const data = accountInfo.data;
    const complete = data[8];
    
    if (complete === 1) {
      console.log("✅ Bonding curve complete! Token graduated. Using Jupiter...");
      return true;
    }
    
    console.log("📊 Token still on pump.fun bonding curve. Using PumpPortal API...");
    return false;
    
  } catch (err) {
    console.error(`⚠️ Bond check error: ${err.message}. Defaulting to Jupiter...`);
    return true;
  }
}

// === PUMP.FUN BUY (Using PumpPortal API) ===
async function buyOnPumpFun(solAmount) {
  try {
    console.log(`🚀 Starting pump.fun buy with PumpPortal API: ${solAmount.toFixed(4)} SOL`);
    console.log(`📍 Buying to treasury, will split XPOSURE after...`);
    
    // Get transaction from PumpPortal
    console.log("📊 Getting PumpPortal transaction...");
    const quoteResponse = await fetch(`https://pumpportal.fun/api/trade-local`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        publicKey: TREASURY_KEYPAIR.publicKey.toBase58(),
        action: "buy",
        mint: TOKEN_MINT.toBase58(),
        denominatedInSol: "true",
        amount: solAmount,
        slippage: 10,
        priorityFee: 0.0001,
        pool: "pump"
      })
    });
    
    if (!quoteResponse.ok) {
      const errorText = await quoteResponse.text();
      throw new Error(`PumpPortal request failed: ${quoteResponse.status} - ${errorText}`);
    }
    
    // PumpPortal returns raw binary transaction data (not base64!)
    const txData = await quoteResponse.arrayBuffer();
    console.log(`✅ Got transaction data (${txData.byteLength} bytes)`);
    
    // Deserialize and sign transaction
    console.log("🔓 Deserializing transaction...");
    const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
    tx.sign([TREASURY_KEYPAIR]);
    
    // Send transaction
    console.log("📤 Sending buy transaction...");
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3
    });
    
    console.log(`📤 Transaction sent: ${sig.substring(0, 8)}...`);
    console.log(`🔗 https://solscan.io/tx/${sig}`);
    console.log("⏳ Confirming transaction...");
    
    await connection.confirmTransaction(sig, "confirmed");
    
    console.log(`✅ Pump.fun buy complete!`);
    
    // Get treasury token account
    const treasuryTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      TREASURY_KEYPAIR.publicKey
    );
    
    // Get balance BEFORE was stored, now get AFTER
    // Wait for balance update
    await new Promise(r => setTimeout(r, 3000));
    
    const afterBalance = await connection.getTokenAccountBalance(treasuryTokenAccount);
    const balanceAfter = Math.floor(parseFloat(afterBalance.value.uiAmount || 0));
    
    // For PumpPortal, we can't get balance before easily, so use a workaround:
    // The transaction itself contains the output amount, but we'll use the approach
    // of just returning what we get. The issue is this returns TOTAL balance.
    // We need to track this differently.
    
    console.log(`🪙 Treasury total balance: ${balanceAfter.toLocaleString()} XPOSURE`);
    console.log(`⚠️ Note: Returning total balance - caller should track balance before purchase`);
    
    return balanceAfter;

    
  } catch (err) {
    console.error(`❌ Pump.fun buy failed: ${err.message}`);
    console.error(err.stack);
    throw err;
  }
}

// === JUPITER SWAP ===
async function buyOnJupiter(solAmount) {
  try {
    console.log(`🪐 Starting Jupiter swap: ${solAmount.toFixed(4)} SOL → XPOSURE`);
    console.log(`📍 Buying to treasury, will split XPOSURE after...`);
    
    const lamports = Math.floor(solAmount * 1e9);
    
    // Get treasury's token account (where tokens will go)
    const treasuryTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      TREASURY_KEYPAIR.publicKey
    );
    
    console.log(`📍 Treasury token account: ${treasuryTokenAccount.toBase58().substring(0, 8)}...`);
    
    // Get quote from Jupiter
    console.log("📊 Getting Jupiter quote...");
    const quoteResponse = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${TOKEN_MINT.toBase58()}&amount=${lamports}&slippageBps=500`
    );
    
    if (!quoteResponse.ok) {
      throw new Error(`Jupiter quote request failed: ${quoteResponse.status} ${quoteResponse.statusText}`);
    }
    
    const quoteData = await quoteResponse.json();
    
    if (!quoteData || quoteData.error) {
      throw new Error(`Quote failed: ${quoteData?.error || 'Unknown error'}`);
    }
    
    // Jupiter returns raw amount - convert to XPOSURE
    const rawOutAmount = parseInt(quoteData.outAmount);
    const outAmount = Math.floor(rawOutAmount / 1_000_000); // Convert to XPOSURE (6 decimals)
    console.log(`💎 Quote received: ${outAmount.toLocaleString()} XPOSURE`);
    
    // Get swap transaction (to treasury's token account)
    console.log("🔨 Building swap transaction...");
    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: TREASURY_KEYPAIR.publicKey.toBase58(),
        destinationTokenAccount: treasuryTokenAccount.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: 100000,
            priorityLevel: "high"
          }
        }
      })
    });
    
    if (!swapResponse.ok) {
      throw new Error(`Jupiter swap request failed: ${swapResponse.status} ${swapResponse.statusText}`);
    }
    
    const swapData = await swapResponse.json();
    
    if (!swapData.swapTransaction) {
      throw new Error('No swap transaction returned from Jupiter');
    }
    
    console.log("✍️ Signing and sending transaction...");
    
    // Deserialize and sign
    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([TREASURY_KEYPAIR]);
    
    const rawTransaction = transaction.serialize();
    const sig = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3
    });
    
    console.log(`📤 Transaction sent: ${sig.substring(0, 8)}...`);
    console.log(`🔗 https://solscan.io/tx/${sig}`);
    console.log("⏳ Confirming transaction...");
    
    await connection.confirmTransaction(sig, 'confirmed');
    
    console.log(`✅ Jupiter swap complete!`);
    console.log(`🪙 Treasury received ${outAmount.toLocaleString()} XPOSURE tokens (will split next)`);
    
    return outAmount;
    
  } catch (err) {
    console.error(`❌ Jupiter swap failed: ${err.message}`);
    console.error(err.stack);
    throw err;
  }
}

// === MARKET INTEGRATION (Auto-detect pump.fun or Jupiter) ===
async function buyXPOSUREOnMarket(solAmount) {
  try {
    console.log(`\n🔄 ========== BUYING XPOSURE ==========`);
    console.log(`💰 Amount: ${solAmount.toFixed(4)} SOL`);
    console.log(`📍 Buying to treasury (will split after)`);
    
    const isBonded = await checkIfBonded();
    
    let xposureAmount;
    if (isBonded) {
      // Use Jupiter
      console.log("📊 Using Jupiter (token graduated)...");
      xposureAmount = await buyOnJupiter(solAmount);
    } else {
      // Try pump.fun, fallback to Jupiter if it fails
      console.log("📊 Trying PumpPortal (token on bonding curve)...");
      try {
        xposureAmount = await buyOnPumpFun(solAmount);
      } catch (pumpError) {
        console.error(`⚠️ PumpPortal failed: ${pumpError.message}`);
        console.log("🔄 Falling back to Jupiter...");
        xposureAmount = await buyOnJupiter(solAmount);
      }
    }
    
    console.log(`✅ Purchase complete! ${xposureAmount.toLocaleString()} XPOSURE now in treasury`);
    console.log(`🔄 ===================================\n`);
    return xposureAmount;
    
  } catch (err) {
    console.error(`❌ Market buy failed: ${err.message}`);
    console.error(err.stack);
    throw err;
  }
}

// === STATE PERSISTENCE ===
const SAVE_FILE = fs.existsSync("/data")
  ? "/data/submissions.json"
  : "./submissions.json";

function saveState() {
  try {
    fs.writeFileSync(
      SAVE_FILE,
      JSON.stringify({
        participants,
        voters,
        phase,
        cycleStartTime,
        nextPhaseTime,
        treasuryXPOSURE,
        actualTreasuryBalance,
        transFeeCollected,
        pendingPayments
      }, null, 2)
    );
  } catch (err) {
    console.error("⚠️ Failed to save state:", err.message);
  }
}

function loadState() {
  if (!fs.existsSync(SAVE_FILE)) return;
  try {
    const d = JSON.parse(fs.readFileSync(SAVE_FILE));
    participants = d.participants || [];
    voters = d.voters || [];
    phase = d.phase || "submission";
    cycleStartTime = d.cycleStartTime || null;
    nextPhaseTime = d.nextPhaseTime || null;
    treasuryXPOSURE = d.treasuryXPOSURE || 0;
    actualTreasuryBalance = d.actualTreasuryBalance || 0;
    transFeeCollected = d.transFeeCollected || 0;
    pendingPayments = d.pendingPayments || [];
    console.log(`📂 State restored — ${participants.length} participants, phase: ${phase}, Treasury: ${actualTreasuryBalance.toLocaleString()} XPOSURE`);
  } catch (e) {
    console.error("⚠️ Failed to load:", e.message);
  }
}

// === EXPRESS SERVER ===
const app = express();
app.use(cors());
app.use(express.json({ limit: '10kb' })); // Limit request size
const PORT = process.env.PORT || 10000;

// === RATE LIMITING ===
const paymentLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // 10 payment confirmations per minute per IP
  message: { error: '⚠️ Too many payment attempts, please wait' },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  message: { error: '⚠️ Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.get("/", generalLimiter, async (_, res) => {
  const uploaders = participants.filter(p => p.choice === "upload" && p.paid).length;
  const voteOnly = voters.length;
  const bonusPercentage = getTreasuryBonusPercentage();
  
  res.json({
    status: "✅ Xposure Buy XPOSURE System Live",
    mode: "webhook",
    phase,
    uploaders,
    voteOnly,
    roundPrizePool: treasuryXPOSURE.toLocaleString() + " XPOSURE",
    actualTreasury: actualTreasuryBalance.toLocaleString() + " XPOSURE",
    bonusPrize: `${calculateTreasuryBonus().toLocaleString()} XPOSURE (${(bonusPercentage * 100).toFixed(0)}%)`,
    bonusChance: `1 in ${TREASURY_BONUS_CHANCE}`,
    transFees: transFeeCollected.toFixed(4) + " SOL",
    uptime: process.uptime()
  });
});

app.post(`/webhook/${token}`, generalLimiter, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// === PAYMENT CONFIRMATION ===
app.post("/confirm-payment", paymentLimiter, async (req, res) => {
  console.log("\n==============================================");
  console.log("🔔 /confirm-payment ENDPOINT HIT!");
  console.log("📦 Request body:", JSON.stringify(req.body, null, 2));
  console.log("==============================================\n");
  
  try {
    const { signature, reference, userId, amount, senderWallet } = req.body;
    
    // === VALIDATION ===
    console.log("🔍 Validating parameters...");
    if (!userId || !reference || !senderWallet) {
      console.log("❌ MISSING PARAMETERS!");
      console.warn("⚠️ Missing params:", req.body);
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    // Validate amount is reasonable
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < 0.001 || amountNum > 100) {
      console.log("❌ INVALID AMOUNT:", amount);
      return res.status(400).json({ error: "Invalid amount (must be 0.001-100 SOL)" });
    }
    
    // Validate wallet address
    try {
      new PublicKey(senderWallet);
    } catch (e) {
      console.log("❌ INVALID WALLET:", senderWallet);
      return res.status(400).json({ error: "Invalid wallet address" });
    }
    
    console.log("✅ Parameters validated!");

    const userKey = String(userId);
    
    console.log(`\n💳 ========== PAYMENT RECEIVED ==========`);
    console.log(`💰 Amount: ${amountNum} SOL`);
    console.log(`👤 User: ${userKey}`);
    console.log(`👛 Wallet: ${senderWallet.substring(0, 8)}...`);
    console.log(`📝 Reference: ${reference.substring(0, 8)}...`);
    console.log(`=====================================\n`);

    // Check for duplicates
    let existing = pendingPayments.find((p) => p.reference === reference);
    if (existing && existing.confirmed) {
      console.log("⚠️ Payment already processed - returning success");
      return res.json({ ok: true, message: "Already processed" });
    }

    if (existing) {
      existing.confirmed = true;
    } else {
      pendingPayments.push({
        userId: userKey,
        reference,
        confirmed: true,
      });
    }

    // === PAYMENT SPLIT ===
    console.log("💰 Calculating payment split...");
    const transFee = amountNum * 0.10;
    const remainingSOL = amountNum * 0.90;
    
    const tier = getTier(amountNum);
    let retention = tier.retention;
    let multiplier = tier.multiplier;
    
    if (tier === TIERS.WHALE) {
      retention = getWhaleRetention(amountNum);
      multiplier = getWhaleMultiplier(amountNum);
    }
    
    console.log(`\n💰 ========== PAYMENT SPLIT ==========`);
    console.log(`🏦 Trans Fee (10%): ${transFee.toFixed(4)} SOL → Fee wallet`);
    console.log(`💎 Buy XPOSURE with: ${remainingSOL.toFixed(4)} SOL`);
    console.log(`📊 Then split XPOSURE tokens:`);
    console.log(`   👤 User gets: ${(retention * 100).toFixed(0)}% of XPOSURE`);
    console.log(`   🏆 Competition pool: ${((1 - retention) * 100).toFixed(0)}% of XPOSURE`);
    console.log(`${tier.badge} Tier: ${tier.name} | ${multiplier}x multiplier`);
    console.log(`=====================================\n`);

    // === SEND TRANS FEE ===
    console.log("💸 Sending trans fee...");
    try {
      await sendSOLPayout(TRANS_FEE_WALLET.toBase58(), transFee, "Trans fee");
      transFeeCollected += transFee;
      console.log("✅ Trans fee sent successfully");
    } catch (err) {
      console.error(`❌ Trans fee failed: ${err.message}`);
    }

    // === BUY XPOSURE WITH ALL REMAINING SOL ===
    let totalXPOSURE = 0;
    console.log("\n🪙 Starting XPOSURE purchase with ALL remaining SOL...");
    
    // Get treasury balance BEFORE purchase
    let balanceBefore = 0;
    try {
      const treasuryTokenAccount = await getAssociatedTokenAddress(
        TOKEN_MINT,
        TREASURY_KEYPAIR.publicKey
      );
      const beforeBalance = await connection.getTokenAccountBalance(treasuryTokenAccount);
      balanceBefore = Math.floor(parseFloat(beforeBalance.value.uiAmount || 0));
      console.log(`📊 Treasury balance BEFORE: ${balanceBefore.toLocaleString()} XPOSURE`);
    } catch (e) {
      console.log(`📊 Treasury balance BEFORE: 0 XPOSURE (account doesn't exist yet)`);
      balanceBefore = 0;
    }
    
    try {
      await buyXPOSUREOnMarket(remainingSOL); // Execute purchase
      
      // Get treasury balance AFTER purchase
      const treasuryTokenAccount = await getAssociatedTokenAddress(
        TOKEN_MINT,
        TREASURY_KEYPAIR.publicKey
      );
      await new Promise(r => setTimeout(r, 2000)); // Wait for balance update
      const afterBalance = await connection.getTokenAccountBalance(treasuryTokenAccount);
      const balanceAfter = Math.floor(parseFloat(afterBalance.value.uiAmount || 0));
      console.log(`📊 Treasury balance AFTER: ${balanceAfter.toLocaleString()} XPOSURE`);
      
      // Calculate actual tokens received
      totalXPOSURE = balanceAfter - balanceBefore;
      console.log(`\n✅ XPOSURE purchase SUCCESS: ${totalXPOSURE.toLocaleString()} XPOSURE tokens received`);
    } catch (err) {
      console.error(`\n❌ XPOSURE purchase FAILED: ${err.message}`);
      console.error(err.stack);
    }

    // === CHECK IF PURCHASE WAS SUCCESSFUL ===
    if (totalXPOSURE === 0 || !totalXPOSURE) {
      console.log("⚠️ XPOSURE purchase returned 0 tokens - notifying user of failure");
      
      try {
        await bot.sendMessage(
          userId,
          `❌ Purchase Failed!\n\n⚠️ We received your ${amountNum} SOL payment, but the XPOSURE token purchase failed.\n\n🔄 Please contact support or try again.\n\nError: Token purchase returned 0 tokens.`
        );
      } catch (e) {
        console.error("⚠️ Failed to send error message:", e.message);
      }
      
      console.log("✅ Error notification sent - returning error to client\n");
      return res.json({ ok: false, error: "XPOSURE purchase failed", xposureAmount: 0 });
    }

    // === SPLIT XPOSURE TOKENS ===
    const userXPOSURE = Math.floor(totalXPOSURE * retention);
    const competitionXPOSURE = totalXPOSURE - userXPOSURE;
    
    console.log(`\n💎 ========== XPOSURE TOKEN SPLIT ==========`);
    console.log(`🪙 Total XPOSURE bought: ${totalXPOSURE.toLocaleString()}`);
    console.log(`👤 User gets: ${userXPOSURE.toLocaleString()} XPOSURE (${(retention * 100).toFixed(0)}%)`);
    console.log(`🏆 Competition pool: ${competitionXPOSURE.toLocaleString()} XPOSURE (${((1 - retention) * 100).toFixed(0)}%)`);
    console.log(`========================================\n`);

    // === TRANSFER USER'S PORTION ===
    console.log(`📤 Transferring ${userXPOSURE.toLocaleString()} XPOSURE to user...`);
    const transferSuccess = await transferTokensToRecipient(userXPOSURE, senderWallet);
    
    if (!transferSuccess) {
      console.error("❌ Transfer failed!");
      try {
        await bot.sendMessage(
          userId,
          `❌ Transfer Failed!\n\n⚠️ XPOSURE purchase succeeded but transfer to your wallet failed.\n\nPlease contact support.`
        );
      } catch (e) {}
      return res.json({ ok: false, error: "Transfer failed", xposureAmount: 0 });
    }

    console.log(`✅ ${userXPOSURE.toLocaleString()} XPOSURE → ${senderWallet.substring(0, 8)}...`);

    // === SPLIT COMPETITION POOL ===
    // 65% goes to round prize pool (gets distributed)
    // 35% goes to permanent treasury (saved, only used for bonus)
    const roundPool = Math.floor(competitionXPOSURE * 0.65);
    const permanentTreasury = competitionXPOSURE - roundPool;
    
    treasuryXPOSURE += roundPool;
    actualTreasuryBalance += permanentTreasury;
    
    console.log(`\n🏦 Pool Distribution:`);
    console.log(`   Round Pool: +${roundPool.toLocaleString()} XPOSURE (65%) → Total: ${treasuryXPOSURE.toLocaleString()} XPOSURE`);
    console.log(`   Permanent Treasury: +${permanentTreasury.toLocaleString()} XPOSURE (35%) → Total: ${actualTreasuryBalance.toLocaleString()} XPOSURE`);
    console.log(`   Bonus Prize Available: ${calculateTreasuryBonus().toLocaleString()} XPOSURE (${(getTreasuryBonusPercentage() * 100).toFixed(0)}%)`);

    // === SAVE USER DATA ===
    const userData = {
      userId: userKey,
      wallet: senderWallet,
      amount: amountNum,
      xposureReceived: userXPOSURE,
      tier: tier.name,
      tierBadge: tier.badge,
      retention: (retention * 100).toFixed(0) + "%",
      multiplier,
      paid: true,
      timestamp: Date.now()
    };

    // === REGISTER USER BASED ON PRE-SELECTED CHOICE ===
    const payment = pendingPayments.find(p => p.reference === reference);
    const userChoice = payment?.choice || "vote"; // Default to vote if somehow missing

    if (userChoice === "upload") {
      // Register as competitor
      if (!payment.track) {
        console.log("⚠️ User chose upload but didn't send audio - defaulting to vote");
        voters.push({
          ...userData,
          choice: "vote",
          votedFor: null
        });
        
        try {
          await bot.sendMessage(
            userId,
            `✅ Payment complete!\n\n🪙 ${userXPOSURE.toLocaleString()} XPOSURE sent!\n${tier.badge} ${tier.name} tier (${(retention * 100).toFixed(0)}% retention)\n💰 ${multiplier}x prize multiplier\n\n⚠️ No audio found - registered as voter.\n🗳️ Vote during voting phase to earn rewards!`
          );
        } catch (e) {
          console.error("⚠️ DM error:", e.message);
        }
      } else {
        participants.push({
          ...userData,
          choice: "upload",
          user: payment.user,
          track: payment.track,
          title: payment.title,
          trackDuration: payment.trackDuration || 0,
          votes: 0,
          voters: []
        });
        
        // Calculate time until voting
        const now = Date.now();
        let timeUntilVote = "";
        if (cycleStartTime && phase === "submission") {
          const submissionEndTime = cycleStartTime + (5 * 60 * 1000);
          const timeLeft = Math.max(0, submissionEndTime - now);
          const minutesLeft = Math.ceil(timeLeft / 60000);
          timeUntilVote = `\n⏰ Voting starts in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}!`;
        }
        
        try {
          await bot.sendMessage(
            userId,
            `✅ Track entered!\n\n🪙 ${userXPOSURE.toLocaleString()} XPOSURE sent!\n${tier.badge} ${tier.name} tier (${(retention * 100).toFixed(0)}% retention)\n💰 ${multiplier}x prize multiplier\n\n🎤 Your track "${payment.title}" is in the competition!${timeUntilVote}\n🍀 Good luck!`
          );
        } catch (e) {
          console.error("⚠️ DM error:", e.message);
        }
        
        // Announce to both channels
        try {
          await bot.sendMessage(
            `@${MAIN_CHANNEL}`,
            `💰 +${roundPool.toLocaleString()} XPOSURE added to prize pool!\n🎤 ${payment.user} entered with "${payment.title}"\n\n💎 Current Pool: ${treasuryXPOSURE.toLocaleString()} XPOSURE`
          );
        } catch (e) {
          console.error("⚠️ Main channel announcement error:", e.message);
        }
        
        try {
          await bot.sendMessage(
            `@${CHANNEL}`,
            `💰 +${roundPool.toLocaleString()} XPOSURE added!\n🎤 ${payment.user} - "${payment.title}"\n\n💎 Pool: ${treasuryXPOSURE.toLocaleString()} XPOSURE`
          );
        } catch (e) {
          console.error("⚠️ Submissions channel announcement error:", e.message);
        }
      }
    } else {
      // Register as voter
      voters.push({
        ...userData,
        choice: "vote",
        votedFor: null
      });
      
      // Calculate time until voting
      const now = Date.now();
      let timeUntilVote = "";
      if (cycleStartTime && phase === "submission") {
        const submissionEndTime = cycleStartTime + (5 * 60 * 1000);
        const timeLeft = Math.max(0, submissionEndTime - now);
        const minutesLeft = Math.ceil(timeLeft / 60000);
        timeUntilVote = `\n⏰ Voting starts in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}!`;
      }
      
      try {
        await bot.sendMessage(
          userId,
          `✅ Registered as voter!\n\n🪙 ${userXPOSURE.toLocaleString()} XPOSURE sent!\n${tier.badge} ${tier.name} tier (${(retention * 100).toFixed(0)}% retention)\n💰 ${multiplier}x prize multiplier${timeUntilVote}\n\n🗳️ Vote during voting phase to earn rewards!`
        );
      } catch (e) {
        console.error("⚠️ DM error:", e.message);
      }
      
      // Announce to both channels
      try {
        await bot.sendMessage(
          `@${MAIN_CHANNEL}`,
          `💰 +${roundPool.toLocaleString()} XPOSURE added to prize pool!\n🗳️ New voter joined\n\n💎 Current Pool: ${treasuryXPOSURE.toLocaleString()} XPOSURE`
        );
      } catch (e) {
        console.error("⚠️ Main channel announcement error:", e.message);
      }
      
      try {
        await bot.sendMessage(
          `@${CHANNEL}`,
          `💰 +${roundPool.toLocaleString()} XPOSURE added!\n🗳️ Voter joined\n\n💎 Pool: ${treasuryXPOSURE.toLocaleString()} XPOSURE`
        );
      } catch (e) {
        console.error("⚠️ Submissions channel announcement error:", e.message);
      }
    }

    // Mark as paid
    if (payment) {
      payment.paid = true;
      payment.userData = userData;
    }

    saveState();

    console.log("✅ Payment processing complete - returning success to client\n");
    res.json({ ok: true, xposureAmount: userXPOSURE });
  } catch (err) {
    console.error(`\n💥 FATAL ERROR in confirm-payment: ${err.message}`);
    console.error(err.stack);
    res.status(500).json({ error: "Internal error" });
  }
});

// === SOL PAYOUT (for trans fees) ===
async function sendSOLPayout(destination, amountSOL, reason = "payout") {
  try {
    const lamports = Math.floor(amountSOL * 1e9);
    if (lamports <= 0) return;
    
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: TREASURY_KEYPAIR.publicKey,
        toPubkey: new PublicKey(destination),
        lamports,
      })
    );
    tx.feePayer = TREASURY_KEYPAIR.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const sig = await connection.sendTransaction(tx, [TREASURY_KEYPAIR]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`💸 ${reason}: ${amountSOL.toFixed(4)} SOL → ${destination.substring(0, 8)}...`);
  } catch (err) {
    console.error(`⚠️ ${reason} failed: ${err.message}`);
  }
}

// === XPOSURE TOKEN PAYOUT ===
async function sendXPOSUREPayout(destination, amountXPOSURE, reason = "payout") {
  try {
    console.log(`💸 ${reason}: ${amountXPOSURE.toLocaleString()} XPOSURE → ${destination.substring(0, 8)}...`);
    
    const success = await transferTokensToRecipient(amountXPOSURE, destination);
    
    if (!success) {
      console.error(`⚠️ ${reason} failed!`);
    }
    
  } catch (err) {
    console.error(`⚠️ ${reason} failed: ${err.message}`);
  }
}

// === START NEW CYCLE ===
async function startNewCycle() {
  console.log("🔄 Starting new cycle...");
  
  phase = "submission";
  cycleStartTime = Date.now();
  nextPhaseTime = cycleStartTime + 5 * 60 * 1000;
  saveState();

  const botUsername = process.env.BOT_USERNAME || '@xposure_overlord_bot';
  const treasuryBonus = calculateTreasuryBonus();
  
  const prizePoolText = treasuryXPOSURE === 0 && actualTreasuryBalance === 0 ? "Loading..." : `${treasuryXPOSURE.toLocaleString()} XPOSURE`;
  const bonusPrizeText = actualTreasuryBalance === 0 ? "Loading..." : `+${treasuryBonus.toLocaleString()} XPOSURE (1/500)`;
  
  console.log(`🎬 NEW CYCLE: Submission phase (5 min), Round pool: ${treasuryXPOSURE.toLocaleString()} XPOSURE, Bonus: ${treasuryBonus.toLocaleString()} XPOSURE`);
  
  try {
    const botMention = botUsername.startsWith('@') ? botUsername : `@${botUsername}`;
    
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🎬 NEW ROUND STARTED!\n\n💰 Prize Pool: Loading...\n🎰 Bonus Prize: ${bonusPrizeText}\n⏰ 5 minutes to join!\n\n🎮 How to Play:\n1️⃣ Open ${botMention}\n2️⃣ Type /start\n3️⃣ Choose your path:\n   🎤 Upload track & compete for prizes\n   🗳️ Vote only & earn rewards\n4️⃣ Buy XPOSURE tokens (0.01 SOL minimum)\n5️⃣ Win XPOSURE prizes! 🏆\n\n🚀 Start now!`
    );
    console.log("✅ Posted cycle start to main channel");
  } catch (err) {
    console.error("❌ Failed to announce:", err.message);
  }

  setTimeout(() => startVoting(), 5 * 60 * 1000);
}

// === VOTING ===
async function startVoting() {
  console.log(`📋 Starting voting — Uploaders: ${participants.filter(p => p.choice === "upload" && p.paid).length}`);
  
  const uploaders = participants.filter((p) => p.choice === "upload" && p.paid);
  
  if (!uploaders.length) {
    console.log("🚫 No uploads this round");
    
    try {
      await bot.sendMessage(
        `@${MAIN_CHANNEL}`,
        `⏰ No tracks submitted this round.\n\n💰 ${treasuryXPOSURE.toLocaleString()} XPOSURE carries over!\n\n🎮 New round starting in 1 minute...`
      );
    } catch {}
    
    phase = "cooldown";
    saveState();
    setTimeout(() => startNewCycle(), 60 * 1000);
    return;
  }

  phase = "voting";
  const votingDuration = calculateVotingTime();
  const votingMinutes = Math.ceil(votingDuration / 60000);
  nextPhaseTime = Date.now() + votingDuration;
  saveState();

  const treasuryBonus = calculateTreasuryBonus();

  try {
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🗳️ VOTING STARTED!\n\n🎤 ${uploaders.length} track${uploaders.length !== 1 ? 's' : ''} competing\n⏰ ${votingMinutes} minute${votingMinutes !== 1 ? 's' : ''} to vote!\n\n💰 Prize Pool: Loading... XPOSURE\n🎰 Bonus Prize: +${treasuryBonus.toLocaleString()} XPOSURE (1/500)\n\n🔥 Listen to tracks & vote for your favorite!\n📍 Vote here: https://t.me/${CHANNEL}\n\n🏆 Winners get 80% of prize pool\n💰 Voters who pick the winner share 20%!`
    );
  } catch {}

  try {
    await bot.sendMessage(
      `@${CHANNEL}`,
      `🗳️ VOTING STARTED!\n\n💰 Prize Pool: ${treasuryXPOSURE.toLocaleString()} XPOSURE\n🎰 Bonus Prize: +${treasuryBonus.toLocaleString()} XPOSURE (1/500)\n⏰ ${votingMinutes} minute${votingMinutes !== 1 ? 's' : ''} to vote!\n\n🎤 Listen to each track below\n🔥 Vote for your favorite!\n\n🏆 Top 5 tracks win prizes\n💎 Vote for the winner = earn rewards!`
    );

    for (const p of uploaders) {
      await bot.sendAudio(`@${CHANNEL}`, p.track, {
        caption: `${p.tierBadge} ${p.user} — ${p.title}\n🔥 0`,
        reply_markup: {
          inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${p.userId}` }]]
        }
      });
      await new Promise((r) => setTimeout(r, 1200));
    }
    console.log(`✅ Posted ${uploaders.length} tracks, voting for ${votingMinutes} minutes`);
  } catch (err) {
    console.error("❌ Voting failed:", err.message);
  }

  setTimeout(() => announceWinners(), votingDuration);
}

// === ANNOUNCE WINNERS ===
async function announceWinners() {
  console.log(`🏆 Announcing winners...`);
  
  phase = "cooldown";
  saveState();
  
  const uploaders = participants.filter((p) => p.choice === "upload" && p.paid);
  
  if (!uploaders.length) {
    console.log("🚫 No uploads");
    participants = [];
    voters = [];
    treasuryXPOSURE = 0;
    pendingPayments = [];
    saveState();
    setTimeout(() => startNewCycle(), 60 * 1000);
    return;
  }

  // Check for treasury bonus win
  const wonTreasuryBonus = checkTreasuryBonus();
  const treasuryBonusAmount = calculateTreasuryBonus();
  
  if (wonTreasuryBonus) {
    console.log(`🎰 BONUS PRIZE HIT! Winner gets +${treasuryBonusAmount.toLocaleString()} XPOSURE!`);
  }

  const sorted = [...uploaders].sort((a, b) => b.votes - a.votes);
  const weights = [0.40, 0.25, 0.20, 0.10, 0.05];
  const numWinners = Math.min(5, sorted.length);
  
  const prizePool = Math.floor(treasuryXPOSURE * 0.80);
  const voterPool = treasuryXPOSURE - prizePool;
  
  let resultsMsg = `🏆 Competition Results 🏆\n💰 Prize Pool: ${prizePool.toLocaleString()} XPOSURE\n`;
  
  if (wonTreasuryBonus) {
    resultsMsg += `🎰✨ BONUS PRIZE HIT! ✨🎰\nWinner gets +${treasuryBonusAmount.toLocaleString()} XPOSURE bonus!\n`;
  }
  
  resultsMsg += `\n`;
  
  for (let i = 0; i < numWinners; i++) {
    const w = sorted[i];
    const baseAmt = Math.floor(prizePool * weights[i]);
    let finalAmt = Math.floor(baseAmt * w.multiplier);
    
    // Add treasury bonus to first place winner
    if (i === 0 && wonTreasuryBonus) {
      finalAmt += treasuryBonusAmount;
      actualTreasuryBalance -= treasuryBonusAmount;  // Deduct from actual treasury
    }
    
    const bonusTag = (i === 0 && wonTreasuryBonus) ? ` (+ ${treasuryBonusAmount.toLocaleString()} bonus!)` : '';
    resultsMsg += `#${i + 1} ${w.tierBadge} ${w.user} — ${w.votes}🔥 — ${finalAmt.toLocaleString()} XPOSURE${bonusTag}\n`;
    
    if (w.wallet && finalAmt > 0) {
      await sendXPOSUREPayout(w.wallet, finalAmt, `Prize #${i + 1}`);
      
      try {
        const bonusMsg = (i === 0 && wonTreasuryBonus) ? `\n🎰 BONUS PRIZE: +${treasuryBonusAmount.toLocaleString()} XPOSURE!` : '';
        await bot.sendMessage(w.userId, `🎉 You won ${finalAmt.toLocaleString()} XPOSURE!${bonusMsg} Check your wallet! 🎊`);
      } catch {}
    }
  }

  const winner = sorted[0];
  const winnerVoters = voters.filter(v => v.votedFor === winner.userId);
  
  if (winnerVoters.length > 0 && voterPool > 0) {
    const totalVoterAmount = winnerVoters.reduce((sum, v) => sum + v.amount, 0);
    
    resultsMsg += `\n🗳️ Voter Rewards: ${voterPool.toLocaleString()} XPOSURE\n`;
    
    for (const v of winnerVoters) {
      const share = Math.floor((v.amount / totalVoterAmount) * voterPool);
      
      if (share > 0) {
        await sendXPOSUREPayout(v.wallet, share, "Voter reward");
        
        try {
          await bot.sendMessage(v.userId, `🎉 You voted for the winner!\nReward: ${share.toLocaleString()} XPOSURE 💰`);
        } catch {}
      }
    }
    
    resultsMsg += `✅ ${winnerVoters.length} voter(s) rewarded!`;
  }

  resultsMsg += `\n\n🎰 Bonus Prize every round (1/500 chance)`;

  try {
    await bot.sendMessage(`@${CHANNEL}`, resultsMsg);
    
    const winnerPrize = Math.floor(prizePool * 0.40 * winner.multiplier) + (wonTreasuryBonus ? treasuryBonusAmount : 0);
    const bonusText = wonTreasuryBonus ? ` (including ${treasuryBonusAmount.toLocaleString()} bonus!)` : '';
    
    await bot.sendMessage(
      `@${MAIN_CHANNEL}`,
      `🎉 WINNER: ${winner.tierBadge} ${winner.user}\n💰 Won ${winnerPrize.toLocaleString()} XPOSURE${bonusText}!\n\n🏆 See full results in @${CHANNEL}\n⏰ Next round starts in 1 minute!\n\n🎮 Type /start in the bot to play!`
    );
  } catch {}

  console.log(`💰 Distributed ${treasuryXPOSURE.toLocaleString()} XPOSURE from round pool`);
  if (wonTreasuryBonus) {
    console.log(`🎰 Bonus prize paid: ${treasuryBonusAmount.toLocaleString()} XPOSURE from treasury`);
  }
  
  participants = [];
  voters = [];
  treasuryXPOSURE = 0;
  pendingPayments = [];
  saveState();
  
  setTimeout(() => startNewCycle(), 60 * 1000);
}

// === TELEGRAM HANDLERS ===
bot.onText(/\/start|play/i, async (msg) => {
  const user = msg.from.username ? `@${msg.from.username}` : msg.from.first_name || "Unknown";
  const userId = String(msg.from.id);

  if (phase !== "submission") {
    await bot.sendMessage(userId, `⚠️ ${phase} phase active. Wait for next round!`);
    return;
  }

  const now = Date.now();
  let timeMessage = "";
  
  if (cycleStartTime) {
    const submissionEndTime = cycleStartTime + (5 * 60 * 1000);
    const timeRemaining = Math.max(0, submissionEndTime - now);
    const minutesLeft = Math.ceil(timeRemaining / 60000);
    timeMessage = `\n⏰ ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''} left to join!`;
  }

  const treasuryBonus = calculateTreasuryBonus();

  await bot.sendMessage(
    userId,
    `🎮 Welcome to Xposure Competition!\n\n💰 Prize Pool: ${treasuryXPOSURE.toLocaleString()} XPOSURE\n🎰 Bonus Prize: +${treasuryBonus.toLocaleString()} XPOSURE (1/500)${timeMessage}\n\n🎯 Choose your path:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎤 Upload Track & Compete", callback_data: `start_upload_${userId}` }],
          [{ text: "🗳️ Vote Only & Earn", callback_data: `start_vote_${userId}` }]
        ]
      }
    }
  );
});

bot.on("message", async (msg) => {
  // Ignore non-private chats
  if (msg.chat.type !== "private") return;

  const userId = String(msg.from.id);
  
  // Handle audio files (track uploads)
  if (msg.audio) {
    const user = msg.from.username ? `@${msg.from.username}` : msg.from.first_name || "Unknown";

    if (phase !== "submission") {
      await bot.sendMessage(userId, `⚠️ ${phase} phase active. Type /start when a new round begins!`);
      return;
    }

    // === AUDIO FILE VALIDATION ===
    const validTypes = ['.mp3', '.m4a', '.ogg', '.wav', '.flac', '.aac'];
    const fileName = msg.audio.file_name || "";
    if (fileName && !validTypes.some(ext => fileName.toLowerCase().endsWith(ext))) {
      await bot.sendMessage(
        userId,
        `⚠️ Invalid audio format!\n\n✅ Accepted: MP3, M4A, OGG, WAV, FLAC, AAC\n❌ Your file: ${fileName}\n\nPlease upload a valid audio file.`
      );
      return;
    }

    // Check if user has chosen upload path
    const uploadChoice = pendingPayments.find(p => p.userId === userId && p.choice === "upload" && !p.paid);
    
    if (!uploadChoice) {
      await bot.sendMessage(
        userId,
        `⚠️ Please type /start and choose "Upload Track" first!`
      );
      return;
    }

    // === PREVENT MULTIPLE UPLOADS ===
    if (uploadChoice.track) {
      await bot.sendMessage(
        userId,
        `⚠️ You already uploaded a track!\n\n🎤 ${uploadChoice.title}\n\nWait for payment to complete or start a new round.`
      );
      return;
    }

    // Check if already participated this round
    const alreadyParticipated = participants.find(p => p.userId === userId);
    if (alreadyParticipated) {
      await bot.sendMessage(
        userId,
        `⚠️ You're already in this round!\n\n🎤 ${alreadyParticipated.title}\n\nOne entry per round.`
      );
      return;
    }

    // Save the track with duration
    uploadChoice.track = msg.audio.file_id;
    uploadChoice.title = msg.audio.file_name || msg.audio.title || "Untitled";
    uploadChoice.trackDuration = msg.audio.duration || 0;  // Duration in seconds
    uploadChoice.user = user;
    saveState();

    const reference = uploadChoice.reference;
    const redirectLink = `https://sunolabs-redirect.onrender.com/pay?bot=xposure&recipient=${TREASURY.toBase58()}&amount=0.01&reference=${reference}&userId=${userId}`;

    const durationText = uploadChoice.trackDuration > 0 ? ` (${uploadChoice.trackDuration}s)` : '';
    await bot.sendMessage(
      userId,
      `🎧 Track received!${durationText}\n\n🪙 Now buy XPOSURE tokens to enter the competition!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🪙 Buy XPOSURE & Enter Competition", url: redirectLink }]
          ]
        }
      }
    );
    return;
  }
  
  // Handle /start command (already handled above, but just in case)
  if (msg.text?.match(/^\/start|^play$/i)) {
    return; // Already handled by onText
  }
  
  // Catch-all for any other text message
  if (msg.text) {
    const now = Date.now();
    let phaseInfo = "";
    
    if (phase === "submission" && cycleStartTime) {
      const submissionEndTime = cycleStartTime + (5 * 60 * 1000);
      const timeRemaining = Math.max(0, submissionEndTime - now);
      const minutesLeft = Math.ceil(timeRemaining / 60000);
      phaseInfo = `\n\n⏰ Current round ends in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}!`;
    } else if (phase === "voting") {
      phaseInfo = `\n\n🗳️ Voting is currently active! Check @${CHANNEL}`;
    } else if (phase === "cooldown") {
      phaseInfo = `\n\n⏰ New round starting soon!`;
    }
    
    await bot.sendMessage(
      userId,
      `👋 Hi! Welcome to Xposure Competition!\n\n🎮 To play, type:\n/start\n\nThen choose:\n🎤 Upload track & compete for XPOSURE prizes\n🗳️ Vote only & earn XPOSURE rewards${phaseInfo}`
    );
  }
});

bot.on("callback_query", async (q) => {
  try {
    // Handle initial choice (before payment)
    if (q.data.startsWith("start_")) {
      const [, action, userKey] = q.data.split("_");
      
      if (phase !== "submission") {
        await bot.answerCallbackQuery(q.id, { text: "⚠️ Submission phase ended!" });
        return;
      }

      const reference = Keypair.generate().publicKey;
      const redirectLink = `https://sunolabs-redirect.onrender.com/pay?bot=xposure&recipient=${TREASURY.toBase58()}&amount=0.01&reference=${reference.toBase58()}&userId=${userKey}`;

      if (action === "upload") {
        // User chose to upload track
        pendingPayments.push({
          userId: userKey,
          choice: "upload",
          reference: reference.toBase58(),
          confirmed: false,
          paid: false
        });
        saveState();

        await bot.answerCallbackQuery(q.id, { text: "✅ Upload mode selected!" });
        await bot.sendMessage(
          userKey,
          `🎤 Upload Track & Compete!\n\n📤 Send me your audio file now.`
        );

      } else if (action === "vote") {
        // User chose to vote only
        pendingPayments.push({
          userId: userKey,
          choice: "vote",
          reference: reference.toBase58(),
          confirmed: false,
          paid: false
        });
        saveState();

        await bot.answerCallbackQuery(q.id, { text: "✅ Vote mode selected!" });
        await bot.sendMessage(
          userKey,
          `🗳️ Vote Only & Earn!\n\n🪙 Buy XPOSURE tokens to participate!`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🪙 Buy XPOSURE & Join as Voter", url: redirectLink }]
              ]
            }
          }
        );
      }
      
      return;
    }

    // Handle voting on tracks
    if (q.data.startsWith("vote_")) {
      const [, userIdStr] = q.data.split("_");
      const targetId = String(userIdStr);
      const voterId = String(q.from.id);
      
      const entry = participants.find((p) => String(p.userId) === targetId);
      
      if (!entry) {
        await bot.answerCallbackQuery(q.id, { text: "⚠️ Not found" });
        return;
      }

      if (entry.voters.includes(voterId)) {
        await bot.answerCallbackQuery(q.id, { text: "⚠️ Already voted" });
        return;
      }

      entry.votes++;
      entry.voters.push(voterId);
      
      const voter = voters.find(v => v.userId === voterId);
      if (voter) {
        voter.votedFor = targetId;
      }
      
      saveState();

      try {
        await bot.editMessageCaption(`${entry.tierBadge} ${entry.user} — ${entry.title}\n🔥 ${entry.votes}`, {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: {
            inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${entry.userId}` }]]
          }
        });
      } catch {}
      
      await bot.answerCallbackQuery(q.id, { text: "✅ Voted!" });
    }
  } catch (err) {
    console.error("⚠️ Callback error:", err.message);
  }
});

// === STARTUP ===
app.listen(PORT, async () => {
  console.log(`🌐 Xposure Buy XPOSURE Bot on port ${PORT}`);
  
  loadState();
  
  // Initialize actual treasury balance from blockchain if not set
  if (actualTreasuryBalance === 0) {
    console.log(`🔍 Fetching actual treasury balance from blockchain...`);
    actualTreasuryBalance = await getActualTreasuryBalance();
    saveState();
  }
  
  console.log(`💰 Current round pool: ${treasuryXPOSURE.toLocaleString()} XPOSURE`);
  console.log(`🏦 Actual treasury: ${actualTreasuryBalance.toLocaleString()} XPOSURE`);
  console.log(`🎰 Bonus prize: ${calculateTreasuryBonus().toLocaleString()} XPOSURE (${(getTreasuryBonusPercentage() * 100).toFixed(0)}%)`);
  
  const webhookUrl = `https://xposure-bot.onrender.com/webhook/${token}`;
  try {
    await bot.deleteWebHook();
    await new Promise(resolve => setTimeout(resolve, 1000));
    await bot.setWebHook(webhookUrl);
    console.log("✅ Webhook set");
  } catch (err) {
    console.error("❌ Webhook failed:", err.message);
  }
  
  const now = Date.now();
  
  if (!cycleStartTime || phase === "cooldown") {
    console.log("🚀 Starting new cycle in 3 seconds...");
    setTimeout(() => startNewCycle(), 3000);
  } else if (phase === "submission") {
    const timeLeft = (cycleStartTime + 5 * 60 * 1000) - now;
    if (timeLeft <= 0) {
      setTimeout(() => startVoting(), 1000);
    } else {
      console.log(`⏰ Resuming submission (${Math.ceil(timeLeft / 60000)}m left)`);
      setTimeout(() => startVoting(), timeLeft);
    }
  } else if (phase === "voting") {
    const timeLeft = nextPhaseTime - now;
    if (timeLeft <= 0) {
      setTimeout(() => announceWinners(), 1000);
    } else {
      console.log(`⏰ Resuming voting (${Math.ceil(timeLeft / 60000)}m left)`);
      setTimeout(() => announceWinners(), timeLeft);
    }
  }
});

setInterval(() => {
  console.log(`⏰ Phase: ${phase} | Uploaders: ${participants.filter(p => p.choice === "upload").length} | Voters: ${voters.length}`);
}, 30000);

// === SELF-PING TO PREVENT RENDER SLEEP ===
// Ping self every 10 minutes to keep service awake on free tier
setInterval(async () => {
  try {
    const response = await fetch('https://xposure-bot.onrender.com/');
    console.log('🏓 Self-ping successful - service kept awake');
  } catch (e) {
    console.log('⚠️ Self-ping failed:', e.message);
  }
}, 10 * 60 * 1000); // Every 10 minutes

console.log("✅ Xposure Buy XPOSURE Bot initialized...");
