// === IMPORTS ===
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fetch from "cross-fetch";
import https from "https";  // ✅ ADDED for PumpSwap SSL bypass
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

// === PAYMENT TIMEOUT CONFIGURATION ===
const PAYMENT_TIMEOUT = 10 * 60 * 1000; // 10 minutes timeout for payments

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

// === CLEAN UP EXPIRED PENDING PAYMENTS ===
function cleanupExpiredPayments() {
  const now = Date.now();
  const expiredPayments = pendingPayments.filter(p => {
    const createdTime = p.createdAt || cycleStartTime || now;
    return (now - createdTime) > PAYMENT_TIMEOUT;
  });

  if (expiredPayments.length > 0) {
    console.log(`🧹 Cleaning up ${expiredPayments.length} expired pending payments`);
    
    // Remove expired payments
    pendingPayments = pendingPayments.filter(p => {
      const createdTime = p.createdAt || cycleStartTime || now;
      return (now - createdTime) <= PAYMENT_TIMEOUT;
    });
    
    // Notify users their payment expired
    expiredPayments.forEach(async (payment) => {
      try {
        await bot.sendMessage(
          payment.userId,
          `⏱️ Payment Timeout\n\n` +
          `Your payment session expired. You can upload a new track and try again!\n\n` +
          `Type /start to begin a new submission.`
        );
      } catch (err) {
        console.log(`⚠️ Could not notify user ${payment.userId} about expiration`);
      }
    });
    
    saveState();
  }
}

// === RUN CLEANUP EVERY 2 MINUTES ===
setInterval(() => {
  cleanupExpiredPayments();
}, 2 * 60 * 1000);

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

// === CHECK IF TOKEN HAS GRADUATED ===
async function checkIfGraduated() {
  try {
    console.log("🔍 Checking token graduation status...");
    
    const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    
    // Derive bonding curve PDA
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), TOKEN_MINT.toBuffer()],
      PUMP_PROGRAM
    );
    
    const accountInfo = await connection.getAccountInfo(bondingCurve);
    
    if (!accountInfo) {
      console.log("✅ Token has graduated from pump.fun!");
      return { graduated: true, platform: 'unknown' };
    }
    
    // Check if bonding curve is complete
    const data = accountInfo.data;
    const complete = data[8];
    
    if (complete === 1) {
      console.log("✅ Bonding curve complete! Token graduated.");
      return { graduated: true, platform: 'unknown' };
    }
    
    console.log("📊 Token still on pump.fun bonding curve.");
    return { graduated: false, platform: 'pump' };
    
  } catch (err) {
    console.error(`⚠️ Graduation check error: ${err.message}. Assuming graduated...`);
    return { graduated: true, platform: 'unknown' };
  }
}

// === ✅ NEW: PUMPSWAP BUY (for graduated tokens) ===
async function buyOnPumpSwap(solAmount) {
  try {
    console.log(`🎓 Starting PumpSwap buy: ${solAmount.toFixed(4)} SOL → XPOSURE`);
    console.log(`📍 Token graduated to PumpSwap - using pumpapi.fun...`);
    
    // Create HTTPS agent that bypasses self-signed certificate
    const httpsAgent = new https.Agent({  
      rejectUnauthorized: false
    });
    
    // Get treasury balance BEFORE purchase
    const treasuryTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      TREASURY_KEYPAIR.publicKey
    );
    
    const beforeBalance = await connection.getTokenAccountBalance(treasuryTokenAccount);
    const balanceBefore = Math.floor(parseFloat(beforeBalance.value.uiAmount || 0));
    console.log(`💰 Treasury balance before: ${balanceBefore.toLocaleString()} XPOSURE`);
    
    // Step 1: Get quote from PumpSwap
    console.log("📊 Getting PumpSwap quote...");
    const quoteResponse = await fetch('https://pumpapi.fun/api/trade', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        action: 'buy',
        mint: TOKEN_MINT.toBase58(),
        amount: solAmount,
        denominatedInSol: 'true',
        slippage: 10,
        priorityFee: 0.0005,
        publicKey: TREASURY_KEYPAIR.publicKey.toBase58()
      }),
      agent: httpsAgent
    });

    if (!quoteResponse.ok) {
      const errorText = await quoteResponse.text();
      throw new Error(`PumpSwap quote failed: ${quoteResponse.status} - ${errorText}`);
    }

    const quoteData = await quoteResponse.json();
    
    if (!quoteData.success || !quoteData.transaction) {
      throw new Error(`PumpSwap quote failed: ${quoteData.error || 'No transaction returned'}`);
    }

    console.log(`✅ PumpSwap quote received`);
    
    // Step 2: Deserialize, sign & send transaction
    console.log("🔓 Deserializing transaction...");
    const txData = Buffer.from(quoteData.transaction, 'base64');
    const tx = VersionedTransaction.deserialize(txData);
    tx.sign([TREASURY_KEYPAIR]);

    console.log("📤 Sending swap transaction...");
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3
    });
    
    console.log(`📤 Transaction sent: ${sig.substring(0, 8)}...`);
    console.log(`🔗 https://solscan.io/tx/${sig}`);
    console.log("⏳ Confirming transaction...");
    
    await connection.confirmTransaction(sig, 'confirmed');
    
    console.log(`✅ PumpSwap buy complete!`);
    
    // Get balance AFTER purchase
    await new Promise(r => setTimeout(r, 3000)); // Wait for balance update
    const afterBalance = await connection.getTokenAccountBalance(treasuryTokenAccount);
    const balanceAfter = Math.floor(parseFloat(afterBalance.value.uiAmount || 0));
    
    const xposureReceived = balanceAfter - balanceBefore;
    console.log(`🪙 Treasury received ${xposureReceived.toLocaleString()} XPOSURE`);
    
    return xposureReceived;
    
  } catch (err) {
    console.error(`❌ PumpSwap buy failed: ${err.message}`);
    console.error(err.stack);
    throw err;
  }
}

// === PUMP.FUN BUY (Using PumpPortal API - for bonding curve tokens) ===
async function buyOnPumpFun(solAmount) {
  try {
    console.log(`🚀 Starting pump.fun buy with PumpPortal API: ${solAmount.toFixed(4)} SOL`);
    console.log(`📍 Buying to treasury, will split XPOSURE after...`);
    
    // Get treasury balance BEFORE purchase
    const treasuryTokenAccount = await getAssociatedTokenAddress(
      TOKEN_MINT,
      TREASURY_KEYPAIR.publicKey
    );
    
    const beforeBalance = await connection.getTokenAccountBalance(treasuryTokenAccount);
    const balanceBefore = Math.floor(parseFloat(beforeBalance.value.uiAmount || 0));
    console.log(`💰 Treasury balance before: ${balanceBefore.toLocaleString()} XPOSURE`);
    
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
    
    // Get balance AFTER purchase
    await new Promise(r => setTimeout(r, 3000));
    
    const afterBalance = await connection.getTokenAccountBalance(treasuryTokenAccount);
    const balanceAfter = Math.floor(parseFloat(afterBalance.value.uiAmount || 0));
    
    const xposureReceived = balanceAfter - balanceBefore;
    console.log(`🪙 Treasury received ${xposureReceived.toLocaleString()} XPOSURE`);
    
    return xposureReceived;
    
  } catch (err) {
    console.error(`❌ Pump.fun buy failed: ${err.message}`);
    console.error(err.stack);
    throw err;
  }
}

// === JUPITER SWAP (fallback for graduated tokens if PumpSwap fails) ===
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

// === ✅ UPDATED: MARKET INTEGRATION (Auto-detect platform) ===
async function buyXPOSUREOnMarket(solAmount) {
  try {
    console.log(`\n🔄 ========== BUYING XPOSURE ==========`);
    console.log(`💰 Amount: ${solAmount.toFixed(4)} SOL`);
    console.log(`📍 Buying to treasury (will split after)`);
    
    const status = await checkIfGraduated();
    
    let xposureAmount;
    
    if (!status.graduated) {
      // Token still on bonding curve - use PumpPortal
      console.log("📊 Using PumpPortal (token on bonding curve)...");
      xposureAmount = await buyOnPumpFun(solAmount);
      
    } else {
      // Token has graduated - try PumpSwap first
      console.log("🎓 Token graduated - trying PumpSwap first...");
      try {
        xposureAmount = await buyOnPumpSwap(solAmount);
      } catch (pumpSwapError) {
        console.error(`⚠️ PumpSwap failed: ${pumpSwapError.message}`);
        console.log("🔄 Falling back to Jupiter...");
        try {
          xposureAmount = await buyOnJupiter(solAmount);
        } catch (jupiterError) {
          console.error(`❌ Jupiter also failed: ${jupiterError.message}`);
          throw new Error(`All swap methods failed. PumpSwap: ${pumpSwapError.message}, Jupiter: ${jupiterError.message}`);
        }
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
      })
    );
  } catch (err) {
    console.error("⚠️ Save failed:", err.message);
  }
}

function loadState() {
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const data = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      participants = data.participants || [];
      voters = data.voters || [];
      phase = data.phase || "submission";
      cycleStartTime = data.cycleStartTime || null;
      nextPhaseTime = data.nextPhaseTime || null;
      treasuryXPOSURE = data.treasuryXPOSURE || 0;
      actualTreasuryBalance = data.actualTreasuryBalance || 0;
      transFeeCollected = data.transFeeCollected || 0;
      pendingPayments = data.pendingPayments || [];
      console.log("✅ State loaded");
    }
  } catch (err) {
    console.error("⚠️ Load failed:", err.message);
  }
}

// === EXPRESS SERVER ===
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

app.get("/", (req, res) => {
  res.json({ status: "ok", phase, participants: participants.length, voters: voters.length });
});

// === WEBHOOK ENDPOINT ===
app.post(`/webhook/${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// === PAYMENT CONFIRMATION ENDPOINT ===
app.post("/payment-confirmed", async (req, res) => {
  try {
    const { reference, userId, amount } = req.body;
    
    if (!reference || !userId || !amount) {
      console.log("⚠️ Invalid payment data:", req.body);
      return res.status(400).json({ error: "Missing data" });
    }
    
    console.log(`\n💰 ========== PAYMENT RECEIVED ==========`);
    console.log(`👤 User: ${userId}`);
    console.log(`💵 Amount: ${amount} SOL`);
    console.log(`🔑 Reference: ${reference}`);
    
    const pending = pendingPayments.find(p => p.reference === reference && p.userId === userId);
    
    if (!pending) {
      console.log(`⚠️ No pending payment found`);
      return res.status(404).json({ error: "Not found" });
    }
    
    if (pending.confirmed) {
      console.log(`⚠️ Already confirmed`);
      return res.status(200).json({ message: "Already processed" });
    }
    
    if (phase !== "submission") {
      console.log(`⚠️ Submission phase ended`);
      return res.status(400).json({ error: "Phase ended" });
    }
    
    pending.paid = true;
    pending.amount = parseFloat(amount);
    
    if (pending.choice === "upload" && !pending.track) {
      console.log(`⏳ Waiting for track upload...`);
      await bot.sendMessage(userId, `💰 Payment received! Now upload your audio file.`);
      saveState();
      return res.status(200).json({ message: "Awaiting track" });
    }
    
    // Process the payment with tiered system
    console.log(`\n🔄 Processing ${amount} SOL payment...`);
    
    const tier = getTier(parseFloat(amount));
    const retention = tier === TIERS.WHALE ? getWhaleRetention(parseFloat(amount)) : tier.retention;
    const multiplier = tier === TIERS.WHALE ? getWhaleMultiplier(parseFloat(amount)) : tier.multiplier;
    
    console.log(`${tier.badge} Tier: ${tier.name}`);
    console.log(`📊 Retention: ${(retention * 100).toFixed(1)}%`);
    console.log(`🔢 Multiplier: ${multiplier.toFixed(2)}x`);
    
    // Split: retention to user, rest to treasury
    const userBuyAmount = parseFloat(amount) * retention;
    const treasuryBuyAmount = parseFloat(amount) * (1 - retention);
    
    console.log(`💰 User buy: ${userBuyAmount.toFixed(4)} SOL`);
    console.log(`🏦 Treasury buy: ${treasuryBuyAmount.toFixed(4)} SOL`);
    
    // Buy XPOSURE on market
    let totalXPOSUREBought;
    try {
      totalXPOSUREBought = await buyXPOSUREOnMarket(parseFloat(amount));
    } catch (err) {
      console.error(`❌ Market buy failed: ${err.message}`);
      await bot.sendMessage(
        userId,
        `⚠️ Payment received but token purchase failed. Admin notified. Please contact support.\n\n` +
        `Reference: ${reference}`
      );
      return res.status(500).json({ error: "Market buy failed" });
    }
    
    // Calculate splits
    const userXPOSURE = Math.floor(totalXPOSUREBought * retention);
    const treasuryXPOSURE_addition = totalXPOSUREBought - userXPOSURE;
    
    console.log(`\n💎 Distribution:`);
    console.log(`👤 User receives: ${userXPOSURE.toLocaleString()} XPOSURE`);
    console.log(`🏦 Treasury gets: ${treasuryXPOSURE_addition.toLocaleString()} XPOSURE`);
    
    // Transfer user's portion
    console.log(`\n📤 Transferring ${userXPOSURE.toLocaleString()} XPOSURE to user...`);
    const recipient = pending.user || userId;
    const transferSuccess = await transferTokensToRecipient(userXPOSURE, recipient);
    
    if (!transferSuccess) {
      console.error(`❌ Transfer to user failed`);
      await bot.sendMessage(
        userId,
        `⚠️ Token transfer failed. Admin notified. Tokens are safe in treasury.\n\n` +
        `Your allocation: ${userXPOSURE.toLocaleString()} XPOSURE\n` +
        `Reference: ${reference}`
      );
      return res.status(500).json({ error: "Transfer failed" });
    }
    
    console.log(`✅ User transfer complete!`);
    
    // Update treasury balances
    treasuryXPOSURE += treasuryXPOSURE_addition; // Current round pool
    actualTreasuryBalance += treasuryXPOSURE_addition; // Perpetual treasury
    
    console.log(`\n💰 Treasury Updated:`);
    console.log(`📊 Current round pool: ${treasuryXPOSURE.toLocaleString()} XPOSURE`);
    console.log(`🏦 Total treasury: ${actualTreasuryBalance.toLocaleString()} XPOSURE`);
    
    // Check for treasury bonus
    const wonBonus = checkTreasuryBonus();
    let bonusAmount = 0;
    
    if (wonBonus) {
      bonusAmount = calculateTreasuryBonus();
      console.log(`\n🎰 TREASURY BONUS HIT! ${bonusAmount.toLocaleString()} XPOSURE (${(getTreasuryBonusPercentage() * 100).toFixed(0)}%)`);
    }
    
    // Apply multiplier to entry
    const adjustedAmount = parseFloat(amount) * multiplier;
    
    // Confirm participation
    pending.confirmed = true;
    
    if (pending.choice === "upload") {
      // Add uploader
      participants.push({
        userId: userId,
        user: pending.user || userId,
        track: pending.track,
        title: pending.title,
        trackDuration: pending.trackDuration || 0,
        votes: 0,
        voters: [],
        choice: "upload",
        tierBadge: tier.badge,
        amount: adjustedAmount,
        bonusWon: bonusAmount,
        createdAt: pending.createdAt || Date.now()
      });
      
      console.log(`✅ Uploader added: ${pending.user || userId}`);
      
      await bot.sendMessage(
        userId,
        `✅ Payment Confirmed!\n\n` +
        `${tier.badge} ${tier.name} Entry\n` +
        `💎 Received: ${userXPOSURE.toLocaleString()} XPOSURE\n` +
        `🏦 Prize pool: +${treasuryXPOSURE_addition.toLocaleString()} XPOSURE\n` +
        `🔢 Entry weight: ${adjustedAmount.toFixed(4)} SOL (${multiplier.toFixed(2)}x)\n` +
        (wonBonus ? `\n🎰 BONUS! You won ${bonusAmount.toLocaleString()} extra XPOSURE from the treasury!\n` : '') +
        `\n🎤 Your track is entered! Good luck!\n` +
        `📺 Follow voting at @${CHANNEL}`
      );
      
    } else if (pending.choice === "vote") {
      // Add voter
      voters.push({
        userId: userId,
        votedFor: null,
        tierBadge: tier.badge,
        amount: adjustedAmount,
        bonusWon: bonusAmount,
        createdAt: pending.createdAt || Date.now()
      });
      
      console.log(`✅ Voter added: ${userId}`);
      
      await bot.sendMessage(
        userId,
        `✅ Payment Confirmed!\n\n` +
        `${tier.badge} ${tier.name} Voter\n` +
        `💎 Received: ${userXPOSURE.toLocaleString()} XPOSURE\n` +
        `🏦 Prize pool: +${treasuryXPOSURE_addition.toLocaleString()} XPOSURE\n` +
        `🔢 Voting power: ${adjustedAmount.toFixed(4)} SOL (${multiplier.toFixed(2)}x)\n` +
        (wonBonus ? `\n🎰 BONUS! You won ${bonusAmount.toLocaleString()} extra XPOSURE from the treasury!\n` : '') +
        `\n🗳️ You can vote when tracks are posted!\n` +
        `📺 Watch for tracks at @${CHANNEL}`
      );
    }
    
    // Remove from pending
    pendingPayments = pendingPayments.filter(p => p.reference !== reference);
    saveState();
    
    console.log(`✅ =======================================\n`);
    
    res.status(200).json({ 
      message: "Payment processed",
      userXPOSURE,
      treasuryXPOSURE_addition,
      bonusWon: wonBonus,
      bonusAmount
    });
    
  } catch (err) {
    console.error("❌ Payment processing error:", err);
    console.error(err.stack);
    res.status(500).json({ error: "Processing failed" });
  }
});

// === CYCLE MANAGEMENT ===
function startNewCycle() {
  console.log("\n🎬 ========== NEW CYCLE STARTED ==========");
  
  phase = "submission";
  cycleStartTime = Date.now();
  participants = [];
  voters = [];
  pendingPayments = [];
  
  // treasuryXPOSURE resets each round (fresh prize pool)
  // actualTreasuryBalance keeps growing perpetually
  treasuryXPOSURE = 0;
  
  saveState();
  
  const bonusInfo = `\n🎰 Treasury Bonus: ${calculateTreasuryBonus().toLocaleString()} XPOSURE (${(getTreasuryBonusPercentage() * 100).toFixed(0)}%) - 1 in ${TREASURY_BONUS_CHANCE} chance!`;
  
  bot.sendMessage(
    `@${MAIN_CHANNEL}`,
    `🎬 NEW ROUND STARTED!\n\n` +
    `⏰ 5 minutes to submit!\n\n` +
    `Upload tracks or vote to win XPOSURE prizes!${bonusInfo}\n\n` +
    `💬 DM @xposure_compete_bot to play!`
  );
  
  setTimeout(() => startVoting(), 5 * 60 * 1000);
  console.log("⏰ Submission ends in 5 minutes");
  console.log("==========================================\n");
}

async function startVoting() {
  console.log("\n🗳️ ========== VOTING STARTED ==========");
  
  phase = "voting";
  
  const uploaders = participants.filter(p => p.choice === "upload" && p.track);
  
  if (uploaders.length === 0) {
    console.log("⚠️ No tracks - starting cooldown");
    await bot.sendMessage(`@${MAIN_CHANNEL}`, `⚠️ No tracks submitted this round. New round soon!`);
    setTimeout(() => startNewCycle(), 30 * 1000);
    phase = "cooldown";
    saveState();
    return;
  }
  
  const votingTime = calculateVotingTime();
  nextPhaseTime = Date.now() + votingTime;
  saveState();
  
  console.log(`🎵 ${uploaders.length} tracks in competition`);
  console.log(`👥 ${voters.length} voters ready`);
  console.log(`⏰ Voting time: ${Math.ceil(votingTime / 60000)} minutes`);
  
  await bot.sendMessage(
    `@${CHANNEL}`,
    `🗳️ VOTING OPEN!\n\n🎵 ${uploaders.length} track${uploaders.length > 1 ? 's' : ''}\n👥 ${voters.length} voter${voters.length > 1 ? 's' : ''}\n\n🔥 Vote for your favorite!`
  );
  
  for (const uploader of uploaders) {
    try {
      await bot.sendAudio(`@${CHANNEL}`, uploader.track, {
        caption: `${uploader.tierBadge} ${uploader.user} — ${uploader.title}\n🔥 0`,
        reply_markup: {
          inline_keyboard: [[{ text: "🔥 Vote", callback_data: `vote_${uploader.userId}` }]]
        }
      });
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`⚠️ Failed to post track: ${err.message}`);
    }
  }
  
  setTimeout(() => announceWinners(), votingTime);
  console.log("==========================================\n");
}

async function announceWinners() {
  console.log("\n🏆 ========== ANNOUNCING WINNERS ==========");
  
  phase = "cooldown";
  saveState();
  
  const uploaders = participants.filter(p => p.choice === "upload" && p.track);
  
  if (uploaders.length === 0) {
    console.log("⚠️ No uploaders");
    await bot.sendMessage(`@${MAIN_CHANNEL}`, `⚠️ Round ended with no tracks. New round soon!`);
    setTimeout(() => startNewCycle(), 30 * 1000);
    return;
  }
  
  uploaders.sort((a, b) => b.votes - a.votes);
  
  const winner = uploaders[0];
  const secondPlace = uploaders[1] || null;
  const thirdPlace = uploaders[2] || null;
  
  console.log(`🥇 Winner: ${winner.user} (${winner.votes} votes)`);
  if (secondPlace) console.log(`🥈 Second: ${secondPlace.user} (${secondPlace.votes} votes)`);
  if (thirdPlace) console.log(`🥉 Third: ${thirdPlace.user} (${thirdPlace.votes} votes)`);
  
  // Calculate prizes
  const totalPool = treasuryXPOSURE;
  
  let winnerPrize = Math.floor(totalPool * 0.50);
  let secondPrize = secondPlace ? Math.floor(totalPool * 0.30) : 0;
  let thirdPrize = thirdPlace ? Math.floor(totalPool * 0.15) : 0;
  
  // Distribute any bonus to winner
  if (winner.bonusWon > 0) {
    winnerPrize += winner.bonusWon;
    actualTreasuryBalance -= winner.bonusWon;
    console.log(`🎰 Winner gets treasury bonus: +${winner.bonusWon.toLocaleString()} XPOSURE`);
  }
  
  const voterPool = totalPool - winnerPrize - secondPrize - thirdPrize;
  
  console.log(`\n💰 Prize Distribution:`);
  console.log(`🥇 Winner: ${winnerPrize.toLocaleString()} XPOSURE`);
  if (secondPrize > 0) console.log(`🥈 Second: ${secondPrize.toLocaleString()} XPOSURE`);
  if (thirdPrize > 0) console.log(`🥉 Third: ${thirdPrize.toLocaleString()} XPOSURE`);
  console.log(`🗳️ Voters: ${voterPool.toLocaleString()} XPOSURE`);
  
  // Transfer prizes
  try {
    console.log(`\n📤 Transferring winner prize...`);
    await transferTokensToRecipient(winnerPrize, winner.user);
    
    if (secondPrize > 0 && secondPlace) {
      console.log(`📤 Transferring second place prize...`);
      await transferTokensToRecipient(secondPrize, secondPlace.user);
    }
    
    if (thirdPrize > 0 && thirdPlace) {
      console.log(`📤 Transferring third place prize...`);
      await transferTokensToRecipient(thirdPrize, thirdPlace.user);
    }
    
    console.log(`✅ All prizes transferred!`);
    
  } catch (err) {
    console.error(`❌ Prize transfer error: ${err.message}`);
  }
  
  // Distribute voter rewards
  if (voters.length > 0 && voterPool > 0) {
    console.log(`\n🗳️ Distributing voter rewards...`);
    
    const totalVoterWeight = voters.reduce((sum, v) => sum + (v.amount || 0.01), 0);
    
    for (const voter of voters) {
      const voterWeight = voter.amount || 0.01;
      const voterShare = (voterWeight / totalVoterWeight) * voterPool;
      const voterPrize = Math.floor(voterShare);
      
      if (voterPrize > 0) {
        try {
          await transferTokensToRecipient(voterPrize, voter.userId);
          console.log(`✅ Voter ${voter.userId}: ${voterPrize.toLocaleString()} XPOSURE`);
        } catch (err) {
          console.error(`⚠️ Voter reward failed: ${err.message}`);
        }
      }
    }
  }
  
  // Announce results
  let announcement = `🏆 ROUND COMPLETE!\n\n`;
  announcement += `🥇 Winner: ${winner.tierBadge} ${winner.user}\n`;
  announcement += `💎 Prize: ${winnerPrize.toLocaleString()} XPOSURE\n`;
  announcement += `🔥 Votes: ${winner.votes}\n`;
  
  if (secondPlace) {
    announcement += `\n🥈 Second: ${secondPlace.tierBadge} ${secondPlace.user}\n`;
    announcement += `💎 ${secondPrize.toLocaleString()} XPOSURE (${secondPlace.votes} votes)\n`;
  }
  
  if (thirdPlace) {
    announcement += `\n🥉 Third: ${thirdPlace.tierBadge} ${thirdPlace.user}\n`;
    announcement += `💎 ${thirdPrize.toLocaleString()} XPOSURE (${thirdPlace.votes} votes)\n`;
  }
  
  if (voters.length > 0) {
    announcement += `\n🗳️ ${voters.length} voters shared ${voterPool.toLocaleString()} XPOSURE!\n`;
  }
  
  announcement += `\n🔄 New round starts in 30 seconds!`;
  
  await bot.sendMessage(`@${MAIN_CHANNEL}`, announcement);
  
  // Deduct distributed prizes from current round pool
  treasuryXPOSURE = Math.max(0, treasuryXPOSURE - (winnerPrize + secondPrize + thirdPrize + voterPool));
  
  // Also deduct any bonus won from actual treasury
  if (winner.bonusWon > 0) {
    actualTreasuryBalance = Math.max(0, actualTreasuryBalance - winner.bonusWon);
  }
  
  saveState();
  
  setTimeout(() => startNewCycle(), 30 * 1000);
  console.log("==========================================\n");
}

// === BOT COMMANDS ===
bot.onText(/^\/start|^play$/i, async (msg) => {
  const userId = String(msg.from.id);
  const user = msg.from.username || msg.from.first_name || userId;
  
  if (msg.chat.type !== "private") return;
  
  if (phase !== "submission") {
    const phaseMsg = phase === "voting" 
      ? `🗳️ Voting is active! Watch @${CHANNEL}`
      : `⏰ New round starting soon!`;
    
    await bot.sendMessage(
      userId,
      `⏰ Submissions closed!\n\n${phaseMsg}\n\nCome back when a new round starts!`
    );
    return;
  }
  
  const alreadyParticipated = participants.find(p => p.userId === userId);
  if (alreadyParticipated) {
    await bot.sendMessage(
      userId,
      `⚠️ You're already in this round!\n\n` +
      `${alreadyParticipated.choice === "upload" ? `🎤 ${alreadyParticipated.title}` : `🗳️ Voter`}\n\n` +
      `One entry per round.`
    );
    return;
  }
  
  const existingPending = pendingPayments.find(p => p.userId === userId);
  if (existingPending) {
    const timeLeft = Math.ceil((PAYMENT_TIMEOUT - (Date.now() - (existingPending.createdAt || cycleStartTime))) / 60000);
    
    if (!existingPending.paid && existingPending.choice === "upload") {
      await bot.sendMessage(
        userId,
        `⏱️ You have a pending upload session.\n\n` +
        `${existingPending.track ? '📤 Track uploaded - waiting for payment' : '📤 Upload your audio file now'}\n\n` +
        `⏱️ ${timeLeft} minute${timeLeft !== 1 ? 's' : ''} remaining`
      );
    } else if (!existingPending.paid && existingPending.choice === "vote") {
      await bot.sendMessage(
        userId,
        `⏱️ You have a pending vote session.\n\n` +
        `💰 Complete payment to join as voter!\n\n` +
        `⏱️ ${timeLeft} minute${timeLeft !== 1 ? 's' : ''} remaining`
      );
    } else {
      await bot.sendMessage(
        userId,
        `⏱️ Payment pending...\n\n` +
        `Please complete your payment to enter!`
      );
    }
    return;
  }
  
  const now = Date.now();
  const submissionEndTime = cycleStartTime + (5 * 60 * 1000);
  const timeRemaining = Math.max(0, submissionEndTime - now);
  const minutesLeft = Math.ceil(timeRemaining / 60000);
  
  await bot.sendMessage(
    userId,
    `🎮 Welcome to Xposure Competition!\n\n` +
    `⏰ ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''} left to enter!\n\n` +
    `Choose your entry:`,
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
  if (msg.chat.type !== "private") return;
  if (!msg.audio) return;
  
  const userId = String(msg.from.id);
  const user = msg.from.username || msg.from.first_name || userId;
  
  const uploadChoice = pendingPayments.find(
    p => p.userId === userId && p.choice === "upload" && !p.track
  );
  
  if (!uploadChoice) {
    await bot.sendMessage(
      userId,
      `⚠️ Start a new entry with /start first!`
    );
    return;
  }
  
  if (phase !== "submission") {
    await bot.sendMessage(
      userId,
      `⚠️ Submission phase ended! Try again next round.`
    );
    pendingPayments = pendingPayments.filter(p => p.reference !== uploadChoice.reference);
    saveState();
    return;
  }
  
  const alreadyParticipated = participants.find(p => p.userId === userId);
  if (alreadyParticipated) {
    await bot.sendMessage(
      userId,
      `⚠️ You're already in this round!\n\n🎤 ${alreadyParticipated.title}\n\nOne entry per round.`
    );
    return;
  }
  
  uploadChoice.track = msg.audio.file_id;
  uploadChoice.title = msg.audio.file_name || msg.audio.title || "Untitled";
  uploadChoice.trackDuration = msg.audio.duration || 0;
  uploadChoice.user = user;
  if (!uploadChoice.createdAt) {
    uploadChoice.createdAt = Date.now();
  }
  saveState();
  
  const reference = uploadChoice.reference;
  const redirectLink = `https://sunolabs-redirect.onrender.com/pay?bot=xposure&recipient=${TREASURY.toBase58()}&amount=0.01&reference=${reference}&userId=${userId}`;
  
  const durationText = uploadChoice.trackDuration > 0 ? ` (${uploadChoice.trackDuration}s)` : '';
  const timeLeft = Math.ceil(PAYMENT_TIMEOUT / 60000);
  
  await bot.sendMessage(
    userId,
    `🎧 Track received!${durationText}\n\n🪙 Complete payment within ${timeLeft} minutes to enter!\n\n⏱️ Session expires if payment not completed.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🪙 Buy XPOSURE & Enter Competition", url: redirectLink }]
        ]
      }
    }
  );
});

bot.on("callback_query", async (q) => {
  try {
    if (q.data.startsWith("start_")) {
      const [, action, userKey] = q.data.split("_");
      
      if (phase !== "submission") {
        await bot.answerCallbackQuery(q.id, { text: "⚠️ Submission phase ended!" });
        return;
      }
      
      const existingPending = pendingPayments.find(p => p.userId === userKey);
      if (existingPending) {
        await bot.answerCallbackQuery(q.id, { text: "⚠️ Already in progress!" });
        return;
      }
      
      const reference = Keypair.generate().publicKey;
      const redirectLink = `https://sunolabs-redirect.onrender.com/pay?bot=xposure&recipient=${TREASURY.toBase58()}&amount=0.01&reference=${reference.toBase58()}&userId=${userKey}`;
      
      if (action === "upload") {
        pendingPayments.push({
          userId: userKey,
          choice: "upload",
          reference: reference.toBase58(),
          confirmed: false,
          paid: false,
          createdAt: Date.now()
        });
        saveState();
        
        await bot.answerCallbackQuery(q.id, { text: "✅ Upload mode selected!" });
        await bot.sendMessage(
          userKey,
          `🎤 Upload Track & Compete!\n\n📤 Send me your audio file now.\n\n⏱️ You have ${Math.ceil(PAYMENT_TIMEOUT / 60000)} minutes to upload and pay.`
        );
        
      } else if (action === "vote") {
        pendingPayments.push({
          userId: userKey,
          choice: "vote",
          reference: reference.toBase58(),
          confirmed: false,
          paid: false,
          createdAt: Date.now()
        });
        saveState();
        
        await bot.answerCallbackQuery(q.id, { text: "✅ Vote mode selected!" });
        await bot.sendMessage(
          userKey,
          `🗳️ Vote Only & Earn!\n\n🪙 Buy XPOSURE tokens to participate!\n\n⏱️ Complete payment within ${Math.ceil(PAYMENT_TIMEOUT / 60000)} minutes.`,
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
  console.log(`⏰ Phase: ${phase} | Uploaders: ${participants.filter(p => p.choice === "upload").length} | Voters: ${voters.length} | Pending: ${pendingPayments.length}`);
}, 30000);

// === SELF-PING TO PREVENT RENDER SLEEP ===
setInterval(async () => {
  try {
    const response = await fetch('https://xposure-bot.onrender.com/');
    console.log('🏓 Self-ping successful - service kept awake');
  } catch (e) {
    console.log('⚠️ Self-ping failed:', e.message);
  }
}, 10 * 60 * 1000);

console.log("✅ Xposure Buy XPOSURE Bot initialized...");
