import secret from "../wallet.json";
import { DecimalUtil } from "@orca-so/common-sdk";
import BN from "bn.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  WhirlpoolContext, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID,
  PDAUtil, PoolUtil, WhirlpoolIx,PriceMath, IGNORE_CACHE
} from "@orca-so/whirlpools-sdk";
import {
  Instruction, EMPTY_INSTRUCTION, resolveOrCreateATA, TransactionBuilder, ZERO
} from "@orca-so/common-sdk";
import dotenv from 'dotenv';
import { Keypair, Connection, SystemProgram, PublicKey,ComputeBudgetProgram, Transaction } from "@solana/web3.js";

import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { AccountLayout, getAssociatedTokenAddressSync, createTransferCheckedInstruction } from "@solana/spl-token";
import {
 
  collectFeesQuote, collectRewardsQuote, TickArrayUtil
} from "@orca-so/whirlpools-sdk";
import Decimal from "decimal.js";
dotenv.config();

// Load environment variables from .env file
dotenv.config();

const RPC_ENDPOINT = process.env.ANCHOR_PROVIDER_URL;
const DESTINATION_WALLET = process.env.DESTINATION_WALLET;
const COMMITMENT = 'confirmed';
const estimated_compute_units = 1_500_000; // ~ 1_400_000 CU
const additional_fee_in_lamports = 1_000_000; // 0.00001 SOL
let EXTRA_LAMP = 3_500_000;
let POSITION = "";


// Define an interface for the JSON response structure
interface PriorityFeesResponse {
  jsonrpc: string;
  result: {
    context: {
      slot: number;
    };
    per_compute_unit: {
      extreme: number;
      high: number;
      low: number;
      medium: number;
      percentiles: {
        [key: string]: number;
      };
    };
    per_transaction: {
      extreme: number;
      high: number;
      low: number;
      medium: number;
      percentiles: {
        [key: string]: number;
      };
    };
  };
  id: number;
}



// Function to fetch the computeExtreme value every hour
async function fetchComputeExtreme() {
  try {
    const myHeaders = new Headers();
    myHeaders.append("Content-Type", "application/json");

    const raw = JSON.stringify({
      "jsonrpc": "2.0",
      "id": 1,
      "method": "qn_estimatePriorityFees",
      "params": {
        "last_n_blocks": 100,
        "account": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
      }
    });

    const requestOptions: RequestInit = {
      method: "POST",
      headers: myHeaders,
      body: raw,
      redirect: "follow"
    };
    const apiUrl = process.env.ANCHOR_PROVIDER_URL; // Use environment variable
    
    if (!apiUrl) {
      throw new Error("API_URL environment variable is not set");
    }

    const response = await fetch(apiUrl, requestOptions);
    
    // Explicitly cast the result to the expected type
    const result = await response.json() as PriorityFeesResponse;

    EXTRA_LAMP = result.result.per_compute_unit.extreme;
    console.log("EXTRA_LAMP: ", EXTRA_LAMP);
  } catch (error) {
    console.error('Error fetching ComputeExtreme:', error);
    // Retain the last known value or default
  }
}


async function getSolBalance(connection: Connection) {
  const keypair = Keypair.fromSecretKey(new Uint8Array(secret));
  const sol_balance = await connection.getBalance(keypair.publicKey);
  return sol_balance;
}

async function getUsdcBalance(connection: Connection) {
  const keypair = Keypair.fromSecretKey(new Uint8Array(secret));
  const token_defs = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { name: "USDC", decimals: 6 },
  };

  const accounts = await connection.getTokenAccountsByOwner(
    keypair.publicKey,
    { programId: TOKEN_PROGRAM_ID }
  );

  for (let i = 0; i < accounts.value.length; i++) {
    const value = accounts.value[i];
    const parsed_token_account = unpackAccount(value.pubkey, value.account);
    const mint = parsed_token_account.mint;
    const token_def = token_defs[mint.toBase58()];
    if (token_def === undefined) continue;
    const amount = parsed_token_account.amount;
    const ui_amount = DecimalUtil.fromBN(new BN(amount.toString()), token_def.decimals);
    return Number(amount.toString());
  }
  return 0; // Return 0 if no USDC account found
}

async function getPositionInfo() {
    try {
      // Create WhirlpoolClient
      const provider = AnchorProvider.env();
      const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
      const client = buildWhirlpoolClient(ctx);
      
      //console.log("wallet pubkey:", ctx.wallet.publicKey.toBase58());
    
      // Get all token accounts
      const token_accounts = (await ctx.connection.getTokenAccountsByOwner(ctx.wallet.publicKey, {programId: TOKEN_PROGRAM_ID})).value;
    
      // Get candidate addresses for the position
      const whirlpool_position_candidate_pubkeys = token_accounts.map((ta) => {
        const parsed = unpackAccount(ta.pubkey, ta.account);
    
        // Derive the address of Whirlpool's position from the mint address (whether or not it exists)
        const pda = PDAUtil.getPosition(ctx.program.programId, parsed.mint);
    
        // Returns the address of the Whirlpool position only if the number of tokens is 1 (ignores empty token accounts and non-NFTs)
        return new BN(parsed.amount.toString()).eq(new BN(1)) ? pda.publicKey : undefined;
      }).filter(pubkey => pubkey !== undefined);
    
      // Get data from Whirlpool position addresses
      const whirlpool_position_candidate_datas = await ctx.fetcher.getPositions(whirlpool_position_candidate_pubkeys, IGNORE_CACHE);
      // Leave only addresses with correct data acquisition as position addresses
      const whirlpool_positions = whirlpool_position_candidate_pubkeys.filter((pubkey, i) => 
        whirlpool_position_candidate_datas[i] !== null
      );
  
      // Array to collect lower and upper bounds
      const bounds = [];
    
      // Output the status of the positions
      for (let i = 0; i < whirlpool_positions.length; i++) {
        const p = whirlpool_positions[i];
    
        // Get the status of the position
        const position = await client.getPosition(p);
        const data = position.getData();
    
        // Get the pool to which the position belongs
        const pool = await client.getPool(data.whirlpool);
        const token_a = pool.getTokenAInfo();
        const token_b = pool.getTokenBInfo();
        const price = PriceMath.sqrtPriceX64ToPrice(pool.getData().sqrtPrice, token_a.decimals, token_b.decimals);
    
        // Get the price range of the position
        const lower_price = PriceMath.tickIndexToPrice(data.tickLowerIndex, token_a.decimals, token_b.decimals);
        const upper_price = PriceMath.tickIndexToPrice(data.tickUpperIndex, token_a.decimals, token_b.decimals);
    
        // Calculate the amount of tokens that can be withdrawn from the position
        const amounts = PoolUtil.getTokenAmountsFromLiquidity(
          data.liquidity,
          pool.getData().sqrtPrice,
          PriceMath.tickIndexToSqrtPriceX64(data.tickLowerIndex),
          PriceMath.tickIndexToSqrtPriceX64(data.tickUpperIndex),
          true
        );
    
        POSITION = p.toBase58();
       
        
             
      }
  
      
    } catch (error) {
      console.error("Error getting position:", error);
      return []; // Return an empty array in case of error
    }
  }
  



  async function collectRewards() {
    // Create WhirlpoolClient
    const provider = AnchorProvider.env();
    const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
    const client = buildWhirlpoolClient(ctx);
  
    //console.log("wallet pubkey:", ctx.wallet.publicKey.toBase58());
  
    // Retrieve the position address from the WHIRLPOOL_POSITION environment variable
    const position_address = POSITION;
    const position_pubkey = new PublicKey(position_address);
    console.log("position address:", position_pubkey.toBase58());
  
    // Get the position and the pool to which the position belongs
    const position = await client.getPosition(position_pubkey);
    const position_owner = ctx.wallet.publicKey;
    const position_token_account = getAssociatedTokenAddressSync(position.getData().positionMint, position_owner);
    const whirlpool_pubkey = position.getData().whirlpool;
    const whirlpool = await client.getPool(whirlpool_pubkey);
    const token_a = whirlpool.getTokenAInfo();
    const token_b = whirlpool.getTokenBInfo();
  
    // Get TickArray and Tick
    const tick_spacing = whirlpool.getData().tickSpacing;
    const tick_array_lower_pubkey = PDAUtil.getTickArrayFromTickIndex(position.getData().tickLowerIndex, tick_spacing, whirlpool_pubkey, ctx.program.programId).publicKey;
    const tick_array_upper_pubkey = PDAUtil.getTickArrayFromTickIndex(position.getData().tickUpperIndex, tick_spacing, whirlpool_pubkey, ctx.program.programId).publicKey;
  
    // Create token accounts to receive fees and rewards
    // Collect mint addresses of tokens to receive
    const tokens_to_be_collected = new Set<string>();
    tokens_to_be_collected.add(token_a.mint.toBase58());
    tokens_to_be_collected.add(token_b.mint.toBase58());
    whirlpool.getData().rewardInfos.map((reward_info) => {
      if ( PoolUtil.isRewardInitialized(reward_info) ) {
        tokens_to_be_collected.add(reward_info.mint.toBase58());
      }
    });
    // Get addresses of token accounts and get instructions to create if it does not exist
    const required_ta_ix: Instruction[] = [];
    const token_account_map = new Map<string, PublicKey>();
    for ( let mint_b58 of tokens_to_be_collected ) {
      const mint = new PublicKey(mint_b58);
      // If present, ix is EMPTY_INSTRUCTION
      const {address, ...ix} = await resolveOrCreateATA(
        ctx.connection,
        position_owner,
        mint,
        () => ctx.fetcher.getAccountRentExempt()
      );
      required_ta_ix.push(ix);
      token_account_map.set(mint_b58, address);
    }
  
    // Build the instruction to update fees and rewards
    let update_fee_and_rewards_ix = WhirlpoolIx.updateFeesAndRewardsIx(
      ctx.program,
      {
        whirlpool: position.getData().whirlpool,
        position: position_pubkey,
        tickArrayLower: tick_array_lower_pubkey,
        tickArrayUpper: tick_array_upper_pubkey,
      }
    );
    
    // Build the instruction to collect fees
    let collect_fees_ix = WhirlpoolIx.collectFeesIx(
      ctx.program,
      {
        whirlpool: whirlpool_pubkey,
        position: position_pubkey,
        positionAuthority: position_owner,
        positionTokenAccount: position_token_account,
        tokenOwnerAccountA: token_account_map.get(token_a.mint.toBase58()),
        tokenOwnerAccountB: token_account_map.get(token_b.mint.toBase58()),
        tokenVaultA: whirlpool.getData().tokenVaultA, 
        tokenVaultB: whirlpool.getData().tokenVaultB,
      }
    );
  
    // Build the instructions to collect rewards
    const collect_reward_ix = [EMPTY_INSTRUCTION, EMPTY_INSTRUCTION, EMPTY_INSTRUCTION];
    for (let i=0; i<whirlpool.getData().rewardInfos.length; i++) {
      const reward_info = whirlpool.getData().rewardInfos[i];
      if ( !PoolUtil.isRewardInitialized(reward_info) ) continue;
  
      collect_reward_ix[i] = WhirlpoolIx.collectRewardIx(
        ctx.program,
        {
          whirlpool: whirlpool_pubkey,
          position: position_pubkey,
          positionAuthority: position_owner,
          positionTokenAccount: position_token_account,
          rewardIndex: i,
          rewardOwnerAccount: token_account_map.get(reward_info.mint.toBase58()),
          rewardVault: reward_info.vault,
        }
      );
    }
  
    // Create a transaction and add the instruction
    const tx_builder = new TransactionBuilder(ctx.connection, ctx.wallet);
    // Create token accounts
    required_ta_ix.map((ix) => tx_builder.addInstruction(ix));
    // Update fees and rewards, collect fees, and collect rewards
    tx_builder
      .addInstruction(update_fee_and_rewards_ix)
      .addInstruction(collect_fees_ix)
      .addInstruction(collect_reward_ix[0])
      .addInstruction(collect_reward_ix[1])
      .addInstruction(collect_reward_ix[2]);
  
    // Send the transaction
  
  
    const set_compute_unit_price_ix = ComputeBudgetProgram.setComputeUnitPrice({
      // Specify how many micro lamports to pay in addition for 1 CU
      microLamports: Math.floor((additional_fee_in_lamports * EXTRA_LAMP) / estimated_compute_units),
    });
    const set_compute_unit_limit_ix = ComputeBudgetProgram.setComputeUnitLimit({
      // To determine the Solana network fee at the start of the transaction, explicitly specify CU
      // If not specified, it will be calculated automatically. But it is almost always specified
      // because even if it is estimated to be large, it will not be refunded
      units: estimated_compute_units,
    });
  
   
    
    // Add instructions to the beginning of the transaction
    tx_builder.prependInstruction({
      instructions: [set_compute_unit_limit_ix, set_compute_unit_price_ix],
      cleanupInstructions: [],
      signers: [],
    });
  
    // Send the transaction
    //const signature = await open_position_tx.tx.buildAndExecute();
    const signature = await tx_builder.buildAndExecute();
    console.log("signature:", signature);
  
    // Wait for the transaction to complete
    const latest_blockhash = await ctx.connection.getLatestBlockhash();
    await ctx.connection.confirmTransaction({signature, ...latest_blockhash}, "confirmed");
  }


async function getBalances() {
  const connection = new Connection(RPC_ENDPOINT, COMMITMENT);
  const solBalance = await getSolBalance(connection);
  const usdcBalance = await getUsdcBalance(connection);
  return { solBalance, usdcBalance };
}


async function transferSol(connection: Connection, amount: any){

     // Initialize a connection to the RPC and read in private key
  const keypair = Keypair.fromSecretKey(new Uint8Array(secret));
  //console.log("wallet pubkey:", keypair.publicKey.toBase58());

  // SOL destination
  const dest_pubkey = new PublicKey(DESTINATION_WALLET);

  
  // Build the instruction to send SOL
  const transfer_ix = SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: dest_pubkey,
    lamports: amount,
  });

  // Create a transaction and add the instruction
  const tx = new Transaction();
  tx.add(transfer_ix);

  // Send the transaction
  const signers = [keypair];
  const signature = await connection.sendTransaction(tx, signers);
  console.log("signature:", signature);

  // Wait for the transaction to complete
  const latest_blockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({signature, ...latest_blockhash});

}

async function transferUsdc(connection: Connection, amount: any){

    const keypair = Keypair.fromSecretKey(new Uint8Array(secret));
  //console.log("endpoint:", connection.rpcEndpoint);
  //console.log("wallet pubkey:", keypair.publicKey.toBase58());

  // devSAMO
  // https://everlastingsong.github.io/nebula/
  const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const USDC_DECIMALS = 6;

  // Destination wallet for the devSAMO
  const dest_pubkey = new PublicKey(DESTINATION_WALLET);

  
  // Obtain the associated token account from the source wallet
  const src_token_account = getAssociatedTokenAddressSync(USDC_MINT, keypair.publicKey);

  // Obtain the associated token account for the destination wallet.
  const {address: dest_token_account, ...create_ata_ix} = await resolveOrCreateATA(
    connection,
    dest_pubkey,
    USDC_MINT,
    ()=>connection.getMinimumBalanceForRentExemption(AccountLayout.span),
    ZERO,
    keypair.publicKey
  );

  // Create the instruction to send devSAMO
  const transfer_ix = createTransferCheckedInstruction(
    src_token_account,
    USDC_MINT,
    dest_token_account,
    keypair.publicKey,
    amount,
    USDC_DECIMALS,
    [],
    TOKEN_PROGRAM_ID
  );

  // Create the transaction and add the instruction
  const tx = new Transaction();
  // Create the destination associated token account (if needed)
  create_ata_ix.instructions.map((ix) => tx.add(ix));
  // Send devSAMO
  tx.add(transfer_ix);

  // Send the transaction
  const signers = [keypair];
  const signature = await connection.sendTransaction(tx, signers);
  console.log("signature:", signature);

  // Wait for the transaction to be confirmed
  const latest_blockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({signature, ...latest_blockhash});

}


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to retry collectRewards with a maximum of 5 retries
async function retryCollectRewards() {
  let retries = 0;
  const maxRetries = 5;
  while (retries < maxRetries) {
    try {
      await collectRewards();
      break; // Exit loop if successful
    } catch (error) {
      retries++;
      if (retries >= maxRetries) {
        console.error("collectRewards() failed after 5 retries.");
        break; // Exit loop after 5 retries
      } else {
        console.error(`collectRewards() failed, retrying in 1000ms (Attempt ${retries}/${maxRetries}):`, error);
        await sleep(1000); // Wait 1000 milliseconds before retrying
      }
    }
  }
}
export async function rewards() {
  try {
    console.log("******************************************************")
    const now = new Date();

    console.log('Current Date and Time:', now.toString()); // Full date and time
    console.log('Date:', now.toDateString()); // Date only
    console.log('Time:', now.toTimeString()); // Time only

    // Establish connection
    const connection = new Connection(RPC_ENDPOINT, COMMITMENT);

    // Fetch initial balances
    const initialBalances = await getBalances();
    console.log("Initial Balances:", initialBalances);

    await getPositionInfo();

    
    // Get quotes and check if tokenA and tokenB are above certain values
    const { feeTokenA, feeTokenB } = await getQuotes();
    const feeTokenAValue = BigInt(Math.round(Number(feeTokenA) * 1_000_000_000));; // Convert Decimal to Number
    const feeTokenBValue = BigInt(Math.round(Number(feeTokenB) * 1_000_000));// Convert Decimal to Number
    
    
        
    
  
    await transferSol(connection, feeTokenAValue);
    console.log("Transfer Sol")
    
    await sleep(1000);
    
    await transferUsdc(connection, feeTokenBValue);
    console.log("Transfer USDC")
    
    await sleep(1000);
            
          
      

      console.log("waiting!");
  } catch (error) {
      console.error("An error occurred:", error);
  }
}

// Dummy function to get quotes
async function getQuotes() {
  // Create WhirlpoolClient
  const provider = AnchorProvider.env();
  const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
  const client = buildWhirlpoolClient(ctx);

  console.log("wallet pubkey:", ctx.wallet.publicKey.toBase58());

  // Token definition
  // devToken specification
  // https://everlastingsong.github.io/nebula/
  const USDC = {name: "USDC", mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), decimals: 6};
  const SOL = {name: "SOL", mint: new PublicKey("So11111111111111111111111111111111111111112"), decimals: 9};
  //const devTMAC = {name: "devTMAC", mint: new PublicKey("Afn8YB1p4NsoZeS5XJBZ18LTfEy5NFPwN46wapZcBQr6"), decimals: 6};
  const token_map = new Map<String, {name: string, mint: PublicKey, decimals: number}>();
  [USDC, SOL].map((token) => token_map.set(token.mint.toBase58(), token));

  // Retrieve the position address from the WHIRLPOOL_POSITION environment variable
  const position_address = POSITION;
  const position_pubkey = new PublicKey(position_address);
  console.log("position address:", position_pubkey.toBase58());

  // Get the position and the pool to which the position belongs
  const position = await client.getPosition(position_pubkey);
  const whirlpool_pubkey = position.getData().whirlpool;
  const whirlpool = await client.getPool(whirlpool_pubkey);

  // Get TickArray and Tick
  const tick_spacing = whirlpool.getData().tickSpacing;
  const tick_array_lower_pubkey = PDAUtil.getTickArrayFromTickIndex(position.getData().tickLowerIndex, tick_spacing, whirlpool_pubkey, ctx.program.programId).publicKey;
  const tick_array_upper_pubkey = PDAUtil.getTickArrayFromTickIndex(position.getData().tickUpperIndex, tick_spacing, whirlpool_pubkey, ctx.program.programId).publicKey;
  const tick_array_lower = await ctx.fetcher.getTickArray(tick_array_lower_pubkey);
  const tick_array_upper = await ctx.fetcher.getTickArray(tick_array_upper_pubkey);
  const tick_lower = TickArrayUtil.getTickFromArray(tick_array_lower, position.getData().tickLowerIndex, tick_spacing);
  const tick_upper = TickArrayUtil.getTickFromArray(tick_array_upper, position.getData().tickUpperIndex, tick_spacing);

  // Get trade fee
  const quote_fee = await collectFeesQuote({
    whirlpool: whirlpool.getData(),
    position: position.getData(),
    tickLower: tick_lower,
    tickUpper: tick_upper,
  });

  const feeTokenA = DecimalUtil.adjustDecimals(new Decimal(quote_fee.feeOwedA.toString()), SOL.decimals);
  const feeTokenB = DecimalUtil.adjustDecimals(new Decimal(quote_fee.feeOwedB.toString()), USDC.decimals);


  console.log("fee tokenA (SOL):", feeTokenA);
  console.log("fee tokenB (USDC):", feeTokenB);

  // Return the adjusted fee values
  return { feeTokenA, feeTokenB };
}




