import { Keypair, Connection, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";

import {
  Instruction, EMPTY_INSTRUCTION, resolveOrCreateATA, TransactionBuilder, Percentage,
  DecimalUtil
} from "@orca-so/common-sdk";
import { WhirlpoolContext,  WhirlpoolIx, decreaseLiquidityQuoteByLiquidityWithParams,increaseLiquidityQuoteByInputTokenWithParams, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID, PDAUtil, swapQuoteByInputToken, IGNORE_CACHE, PriceMath, PoolUtil } from "@orca-so/whirlpools-sdk";
import BN from "bn.js";
import Decimal from "decimal.js";
import dotenv from 'dotenv';
import secret from "../wallet.json";
import { AnchorProvider } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Twilio } from "twilio";
// It is recommended that you use your own RPC endpoint.
// This RPC endpoint is only for demonstration purposes so that this example will run.
import { rewards } from "./1reward";

dotenv.config();

const slip = 10
const SOL = { mint: new PublicKey("So11111111111111111111111111111111111111112"), decimals: 6 };
const USDC = { mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), decimals: 9 };
const DEVNET_WHIRLPOOLS_CONFIG = new PublicKey("2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ");
const TICK_SPACING = 2;
const COMMITMENT = 'confirmed';
const RPC_ENDPOINT = process.env.ANCHOR_PROVIDER_URL;
let POSITION = "";
const estimated_compute_units = 1_500_000; // ~ 1_400_000 CU
//const globalComputeExtreme = 1_000_000; // 0.00001 SOL
// Global variable to store the computeExtreme value, initialized with default 100000
let globalComputeExtreme: number = 1_000_000;;
let EXTRA_LAMP = 3000000;
let solPrice = 0.0;
let lowerBound = 0;
let upperBound = 1000;
let lastAlertOutOfRange = false;
const percentage = 3.0; // Define the percentage as 1%
const PERCENTPOS = 1.0;

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const myNumber = process.env.RECIPIENT_PHONE_NUMBER;


function sendSmsAlert(price: number) {

  if (accountSid && authToken && myNumber && twilioNumber) {
    const client = new Twilio(accountSid, authToken);
  
    client.messages
      .create({
        from: twilioNumber,
        to: myNumber,
        body: `Solana Price Alert: The current price is $${price.toFixed(2)}, which is out of the specified range.`,
      })
      .then((message) => console.log(message.sid));
  } else {
    console.error(
      "You are missing one of the variables you need to send a message"
    );
  }

}


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}



async function collectRewards() {
  // Create WhirlpoolClient

  const provider = AnchorProvider.env();
  const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
  const client = buildWhirlpoolClient(ctx);

 
  // Retrieve the position address from the WHIRLPOOL_POSITION environment variable
  const position_address = process.env.WHIRLPOOL_POSITION;
  const position_pubkey = new PublicKey(POSITION);
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
  const tokens_to_be_collected = new Set<string>();
  tokens_to_be_collected.add(token_a.mint.toBase58());
  tokens_to_be_collected.add(token_b.mint.toBase58());
  whirlpool.getData().rewardInfos.map((reward_info) => {
    if ( PoolUtil.isRewardInitialized(reward_info) ) {
      tokens_to_be_collected.add(reward_info.mint.toBase58());
    }
  });

  const required_ta_ix: Instruction[] = [];
  const token_account_map = new Map<string, PublicKey>();
  for (let mint_b58 of tokens_to_be_collected) {
    const mint = new PublicKey(mint_b58);
    const { address, ...ix } = await resolveOrCreateATA(
      ctx.connection,
      position_owner,
      mint,
      () => ctx.fetcher.getAccountRentExempt()
    );
    required_ta_ix.push(ix);
    token_account_map.set(mint_b58, address);
  }

  // Retrieve balances before the transaction
  const preBalances = new Map<string, number>();
  for (let [mint_b58, account] of token_account_map.entries()) {
    const accountInfo = await ctx.connection.getTokenAccountBalance(account);
    preBalances.set(mint_b58, accountInfo.value.uiAmount || 0);
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
  for (let i = 0; i < whirlpool.getData().rewardInfos.length; i++) {
    const reward_info = whirlpool.getData().rewardInfos[i];
    if (!PoolUtil.isRewardInitialized(reward_info)) continue;

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
  required_ta_ix.map((ix) => tx_builder.addInstruction(ix));
  tx_builder
    .addInstruction(update_fee_and_rewards_ix)
    .addInstruction(collect_fees_ix)
    .addInstruction(collect_reward_ix[0])
    .addInstruction(collect_reward_ix[1])
    .addInstruction(collect_reward_ix[2]);

  const set_compute_unit_price_ix = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: Math.floor((globalComputeExtreme * EXTRA_LAMP) / estimated_compute_units),
  });
  const set_compute_unit_limit_ix = ComputeBudgetProgram.setComputeUnitLimit({
    units: estimated_compute_units,
  });

  tx_builder.prependInstruction({
    instructions: [set_compute_unit_limit_ix, set_compute_unit_price_ix],
    cleanupInstructions: [],
    signers: [],
  });

  const signature = await tx_builder.buildAndExecute();
  console.log("signature:", signature);

  const latest_blockhash = await ctx.connection.getLatestBlockhash();
  await ctx.connection.confirmTransaction({ signature, ...latest_blockhash }, "confirmed");

  // Retrieve balances after the transaction
  const postBalances = new Map<string, number>();
  for (let [mint_b58, account] of token_account_map.entries()) {
    const accountInfo = await ctx.connection.getTokenAccountBalance(account);
    postBalances.set(mint_b58, accountInfo.value.uiAmount || 0);
  }

  // Log the collected tokens
  for (let [mint_b58, preBalance] of preBalances.entries()) {
    const postBalance = postBalances.get(mint_b58) || 0;
    const collectedAmount = postBalance - preBalance;
    console.log(`Collected ${collectedAmount} of token ${mint_b58}`);
  }
}



async function performSwap(amountIn, token, CoinIn, CoinOut) {
  try {
    const provider = AnchorProvider.env();
    const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
    const client = buildWhirlpoolClient(ctx);

    const whirlpool_pubkey = PDAUtil.getWhirlpool(
      ORCA_WHIRLPOOL_PROGRAM_ID,
      DEVNET_WHIRLPOOLS_CONFIG,
      SOL.mint, USDC.mint, TICK_SPACING
    ).publicKey;

    const whirlpool = await client.getPool(whirlpool_pubkey);
    const amount_in_decimal = new Decimal(amountIn);
  
    const quote = await swapQuoteByInputToken(
      whirlpool,
      token.mint,
      DecimalUtil.toBN(amount_in_decimal, token.decimals),
      Percentage.fromFraction(5, 1000),
      ctx.program.programId,
      ctx.fetcher,
      IGNORE_CACHE,
    );

    console.log("estimatedAmountIn:", DecimalUtil.fromBN(quote.estimatedAmountIn, USDC.decimals).toNumber(), CoinIn);
    console.log("estimatedAmountOut:", DecimalUtil.fromBN(quote.estimatedAmountOut, SOL.decimals).toNumber(), CoinOut);

    
    const set_compute_unit_price_ix = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: Math.floor((globalComputeExtreme * EXTRA_LAMP) / estimated_compute_units),
    });
    const set_compute_unit_limit_ix = ComputeBudgetProgram.setComputeUnitLimit({
      units: estimated_compute_units,
    });

    const tx = await whirlpool.swap(quote);
    tx.prependInstruction({
      instructions: [set_compute_unit_limit_ix, set_compute_unit_price_ix],
      cleanupInstructions: [],
      signers: [],
    });

    const signature = await tx.buildAndExecute();
    const latest_blockhash = await ctx.connection.getLatestBlockhash();
    await ctx.connection.confirmTransaction({ signature, ...latest_blockhash }, "confirmed");

    console.log("Transaction successful, signature:", signature);
    return true;
  } catch (error) {
    console.error("Error performing swap:", error);
    return false;
  }
}

async function getSolPrice() {
  try {
    const provider = AnchorProvider.env();
    const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
    const client = buildWhirlpoolClient(ctx);
    const whirlpool_pubkey = PDAUtil.getWhirlpool(
      ORCA_WHIRLPOOL_PROGRAM_ID,
      DEVNET_WHIRLPOOLS_CONFIG,
      SOL.mint, USDC.mint, TICK_SPACING
    ).publicKey;
    const whirlpool = await client.getPool(whirlpool_pubkey);
    const sqrt_price_x64 = whirlpool.getData().sqrtPrice;
    const price = PriceMath.sqrtPriceX64ToPrice(sqrt_price_x64, USDC.decimals, SOL.decimals);
    return price.toNumber();
  } catch (error) {
    console.error("Error retrieving SOL price:", error);
    return 0;
  }
}

async function getSolBalance() {
  try {
    const connection = new Connection(RPC_ENDPOINT, COMMITMENT);
    const keypair = Keypair.fromSecretKey(new Uint8Array(secret));
    const sol_balance = await connection.getBalance(keypair.publicKey);
    return sol_balance / (10 ** 9);
  } catch (error) {
    console.error("Error retrieving SOL balance:", error);
    return 0;
  }
}

async function getUSDCBalance() {
  try {
    const connection = new Connection(RPC_ENDPOINT, COMMITMENT);
    const keypair = Keypair.fromSecretKey(new Uint8Array(secret));
    const tokenDefs = {
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { name: "USDC", decimals: 6 }
    };

    const accounts = await connection.getTokenAccountsByOwner(keypair.publicKey, { programId: TOKEN_PROGRAM_ID });

    for (const { pubkey, account } of accounts.value) {
      const parsedTokenAccount = unpackAccount(pubkey, account);
      const mint = parsedTokenAccount.mint;
      const tokenDef = tokenDefs[mint.toBase58()];

      if (tokenDef) {
        const amount = parsedTokenAccount.amount;
        const uiAmount = DecimalUtil.fromBN(new BN(amount.toString()), tokenDef.decimals);
        return uiAmount.toNumber();
      }
    }
    return 0;
  } catch (error) {
    console.error("Error retrieving USDC balance:", error);
    return 0;
  }
}


async function getPositionInfo() {
  try {
    // Create WhirlpoolClient
    const provider = AnchorProvider.env();
    const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
    const client = buildWhirlpoolClient(ctx);
    
    console.log("wallet pubkey:", ctx.wallet.publicKey.toBase58());
  
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
      lowerBound = parseFloat(lower_price.toFixed(token_b.decimals));
      upperBound = parseFloat(upper_price.toFixed(token_b.decimals));
      let whirlpoolPrice = parseFloat(price.toFixed(token_b.decimals));

      try {
        const price = whirlpoolPrice;
        const outOfRange = price < lowerBound || price > upperBound;
        //sendSmsAlert(price);
        if (outOfRange && !lastAlertOutOfRange) {
          //sendSmsAlert(price);
          lastAlertOutOfRange = true;
          console.log("SMS Sent!")
        } else if (!outOfRange && lastAlertOutOfRange) {
          lastAlertOutOfRange = false;
        }
    
        console.log(`Price is ${outOfRange ? 'out of range' : 'within range'}: $${price.toFixed(2)}`);
      } catch (error) {
        console.error('Failed to fetch price:', error);
      }
           
    }

    
  } catch (error) {
    console.error("Error getting position:", error);
    return []; // Return an empty array in case of error
  }
}



async function openPosition(usdcBalance, solPrice){
  try{
  const provider = AnchorProvider.env();
  const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
  const client = buildWhirlpoolClient(ctx);

  
  console.log("wallet pubkey:", ctx.wallet.publicKey.toBase58());

  // Token definition
  // devToken specification
  // https://everlastingsong.github.io/nebula/
  const USDC = {mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), decimals: 6};
  const SOL = {mint: new PublicKey("So11111111111111111111111111111111111111112"), decimals: 9};

  // WhirlpoolsConfig account
  // devToken ecosystem / Orca Whirlpools
  const DEVNET_WHIRLPOOLS_CONFIG = new PublicKey("2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ");

  // Get SOL/USDC whirlpool
  const tick_spacing = TICK_SPACING;
  const whirlpool_pubkey = PDAUtil.getWhirlpool(
      ORCA_WHIRLPOOL_PROGRAM_ID,
      DEVNET_WHIRLPOOLS_CONFIG,
      SOL.mint, USDC.mint, tick_spacing).publicKey;
  console.log("whirlpool_key:", whirlpool_pubkey.toBase58());
  const whirlpool = await client.getPool(whirlpool_pubkey);

  // Get the current price of the pool
  const sqrt_price_x64 = whirlpool.getData().sqrtPrice;
  const price = PriceMath.sqrtPriceX64ToPrice(sqrt_price_x64, SOL.decimals, USDC.decimals);
  console.log("price:", price.toFixed(USDC.decimals));

  // Set price range, amount of tokens to deposit, and acceptable slippage
  
  const lower_price = new Decimal(solPrice * (1 - percentage / 100));
  const upper_price = new Decimal(solPrice * (1 + percentage / 100));

  const dev_usdc_amount = DecimalUtil.toBN(new Decimal(usdcBalance /* USDC */), USDC.decimals);
  const slippage = Percentage.fromFraction(slip, 1000); // 1%

  // Adjust price range (not all prices can be set, only a limited number of prices are available for range specification)
  // (prices corresponding to InitializableTickIndex are available)
  const whirlpool_data = whirlpool.getData();
  const token_a = whirlpool.getTokenAInfo();
  const token_b = whirlpool.getTokenBInfo();
  const lower_tick_index = PriceMath.priceToInitializableTickIndex(lower_price, token_a.decimals, token_b.decimals, whirlpool_data.tickSpacing);
  const upper_tick_index = PriceMath.priceToInitializableTickIndex(upper_price, token_a.decimals, token_b.decimals, whirlpool_data.tickSpacing);
  console.log("lower & upper tick_index:", lower_tick_index, upper_tick_index);
  console.log("lower & upper price:",
    PriceMath.tickIndexToPrice(lower_tick_index, token_a.decimals, token_b.decimals).toFixed(token_b.decimals),
    PriceMath.tickIndexToPrice(upper_tick_index, token_a.decimals, token_b.decimals).toFixed(token_b.decimals)
  );

  // Obtain deposit estimation
  const quote = increaseLiquidityQuoteByInputTokenWithParams({
    // Pass the pool definition and state
    tokenMintA: token_a.mint,
    tokenMintB: token_b.mint,
    sqrtPrice: whirlpool_data.sqrtPrice,
    tickCurrentIndex: whirlpool_data.tickCurrentIndex,
    // Price range
    tickLowerIndex: lower_tick_index,
    tickUpperIndex: upper_tick_index,
    // Input token and amount
    inputTokenMint: USDC.mint,
    inputTokenAmount: dev_usdc_amount,
    // Acceptable slippage
    slippageTolerance: slippage,
  });

  // Output the estimation
  console.log("SOL max input:", DecimalUtil.fromBN(quote.tokenMaxA, token_a.decimals).toFixed(token_a.decimals));
  console.log("USDC max input:", DecimalUtil.fromBN(quote.tokenMaxB, token_b.decimals).toFixed(token_b.decimals));

  
  const set_compute_unit_price_ix = ComputeBudgetProgram.setComputeUnitPrice({
    // Specify how many micro lamports to pay in addition for 1 CU
    microLamports: Math.floor((globalComputeExtreme * EXTRA_LAMP) / estimated_compute_units),
  });
  const set_compute_unit_limit_ix = ComputeBudgetProgram.setComputeUnitLimit({
    // To determine the Solana network fee at the start of the transaction, explicitly specify CU
    // If not specified, it will be calculated automatically. But it is almost always specified
    // because even if it is estimated to be large, it will not be refunded
    units: estimated_compute_units,
  });

  // Create a transaction
  const open_position_tx = await whirlpool.openPositionWithMetadata(
    lower_tick_index,
    upper_tick_index,
    quote
  );
  
  // Add instructions to the beginning of the transaction
  open_position_tx.tx.prependInstruction({
    instructions: [set_compute_unit_limit_ix, set_compute_unit_price_ix],
    cleanupInstructions: [],
    signers: [],
  });

  // Send the transaction
  const signature = await open_position_tx.tx.buildAndExecute();
  console.log("signature:", signature);
  console.log("position NFT:", open_position_tx.positionMint.toBase58());

  // Wait for the transaction to complete
  const latest_blockhash = await ctx.connection.getLatestBlockhash();
  await ctx.connection.confirmTransaction({signature, ...latest_blockhash}, "confirmed");
}catch (error) {
  console.error("Error opening position:", error);
}
}



async function closePosition() {
  try {
    const provider = AnchorProvider.env();
    const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
    const client = buildWhirlpoolClient(ctx);

    console.log("endpoint:", ctx.connection.rpcEndpoint);
    //console.log("wallet pubkey:", ctx.wallet.publicKey.toBase58());

    // Retrieve the position address from the WHIRLPOOL_POSITION environment variable
    const position_address = process.env.WHIRLPOOL_POSITION;
    const position_pubkey = new PublicKey(POSITION);
    console.log("position address:", position_pubkey.toBase58());

    // Set acceptable slippage
    const slippage = Percentage.fromFraction(slip, 1000); // 1%

    // Get the position and the pool to which the position belongs
    const position = await client.getPosition(position_pubkey);
    const position_owner = ctx.wallet.publicKey;
    const position_token_account = getAssociatedTokenAddressSync(position.getData().positionMint, position_owner);
    const whirlpool_pubkey = position.getData().whirlpool;
    const whirlpool = await client.getPool(whirlpool_pubkey);
    const whirlpool_data = whirlpool.getData();

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
      if (PoolUtil.isRewardInitialized(reward_info)) {
        tokens_to_be_collected.add(reward_info.mint.toBase58());
      }
    });
    // Get addresses of token accounts and get instructions to create if it does not exist
    const required_ta_ix: Instruction[] = [];
    const token_account_map = new Map<string, PublicKey>();
    for (let mint_b58 of tokens_to_be_collected) {
      const mint = new PublicKey(mint_b58);
      // If present, ix is EMPTY_INSTRUCTION
      const { address, ...ix } = await resolveOrCreateATA(
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
    for (let i = 0; i < whirlpool.getData().rewardInfos.length; i++) {
      const reward_info = whirlpool.getData().rewardInfos[i];
      if (!PoolUtil.isRewardInitialized(reward_info)) continue;

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

    // Estimate the amount of tokens that can be withdrawn from the position
    const quote = decreaseLiquidityQuoteByLiquidityWithParams({
      // Pass the pool state as is
      sqrtPrice: whirlpool_data.sqrtPrice,
      tickCurrentIndex: whirlpool_data.tickCurrentIndex,
      // Pass the price range of the position as is
      tickLowerIndex: position.getData().tickLowerIndex,
      tickUpperIndex: position.getData().tickUpperIndex,
      // Liquidity to be withdrawn (All liquidity)
      liquidity: position.getData().liquidity,
      // Acceptable slippage
      slippageTolerance: slippage,
    });

    // Output the estimation
    console.log("SOL min output:", DecimalUtil.fromBN(quote.tokenMinA, token_a.decimals).toFixed(token_a.decimals));
    console.log("USDC min output:", DecimalUtil.fromBN(quote.tokenMinB, token_b.decimals).toFixed(token_b.decimals));

    // Build the instruction to decrease liquidity
    const decrease_liquidity_ix = WhirlpoolIx.decreaseLiquidityIx(
      ctx.program,
      {
        ...quote,
        whirlpool: whirlpool_pubkey,
        position: position_pubkey,
        positionAuthority: position_owner,
        positionTokenAccount: position_token_account,
        tokenOwnerAccountA: token_account_map.get(token_a.mint.toBase58()),
        tokenOwnerAccountB: token_account_map.get(token_b.mint.toBase58()),
        tokenVaultA: whirlpool.getData().tokenVaultA,
        tokenVaultB: whirlpool.getData().tokenVaultB,
        tickArrayLower: tick_array_lower_pubkey,
        tickArrayUpper: tick_array_upper_pubkey,
      }
    );

    // Build the instruction to close the position
    const close_position_ix = WhirlpoolIx.closePositionIx(
      ctx.program,
      {
        position: position_pubkey,
        positionAuthority: position_owner,
        positionTokenAccount: position_token_account,
        positionMint: position.getData().positionMint,
        receiver: position_owner,
      }
    );

    const set_compute_unit_price_ix = ComputeBudgetProgram.setComputeUnitPrice({
      // Specify how many micro lamports to pay in addition for 1 CU
      microLamports: Math.floor((globalComputeExtreme * EXTRA_LAMP) / estimated_compute_units),
    });
    const set_compute_unit_limit_ix = ComputeBudgetProgram.setComputeUnitLimit({
      // To determine the Solana network fee at the start of the transaction, explicitly specify CU
      // If not specified, it will be calculated automatically. But it is almost always specified
      // because even if it is estimated to be large, it will not be refunded
      units: estimated_compute_units,
    });

    // Create a transaction and add the instruction
    const tx_builder = new TransactionBuilder(ctx.connection, ctx.wallet);

    // Create token accounts
    required_ta_ix.map((ix) => tx_builder.addInstruction(ix));
    tx_builder
      // Update fees and rewards, collect fees, and collect rewards
      .addInstruction(update_fee_and_rewards_ix)
      .addInstruction(collect_fees_ix)
      .addInstruction(collect_reward_ix[0])
      .addInstruction(collect_reward_ix[1])
      .addInstruction(collect_reward_ix[2])
      // Decrease liquidity
      .addInstruction(decrease_liquidity_ix)
      // Close the position
      .addInstruction(close_position_ix);

    // Add instructions to the beginning of the transaction
    tx_builder.prependInstruction({
      instructions: [set_compute_unit_limit_ix, set_compute_unit_price_ix],
      cleanupInstructions: [],
      signers: [],
    });

    // Send the transaction
    const signature = await tx_builder.buildAndExecute();
    console.log("signature:", signature);

    // Wait for the transaction to complete
    const latest_blockhash = await ctx.connection.getLatestBlockhash();
    await ctx.connection.confirmTransaction({ signature, ...latest_blockhash }, "confirmed");
    POSITION = "";
  } catch (error) {
    console.error("Error closing position:", error);
  }
}

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

// Start fetching computeExtreme every hour
//setInterval(fetchComputeExtreme, 3600000); // 3600000 ms = 1 hour

// Fetch immediately on start
fetchComputeExtreme();

async function main() {

  console.log("******************************************************")
  const now = new Date();

  console.log('Current Date and Time:', now.toString()); // Full date and time
  console.log('Date:', now.toDateString()); // Date only
  console.log('Time:', now.toTimeString()); // Time only

  
 
  // Use globalComputeExtreme value (either the updated value or default 100000)
  console.log("Using EXTRA_LAMP:", EXTRA_LAMP);

  console.log("Get SOL Price:")
  solPrice = await getSolPrice();
  console.log("SOL Price:", solPrice);
  console.log("Sleep!")
      await sleep(500);


  console.log("Get Positions:")
  await getPositionInfo();
  //fetchComputeExtreme();
  //await rewards().catch(console.error);
  

  await sleep(500);
  if (POSITION === "") {
    console.log("No Position");
  } else {
    console.log(solPrice);
    console.log(lowerBound);
    console.log(upperBound)
    //fetchComputeExtreme();
    // Call rewards() function
    //await collectRewards();
    if (solPrice < lowerBound || solPrice > upperBound) {
    console.log("Closing Position!");
    // Call rewards() function
    fetchComputeExtreme();
    await rewards().catch(console.error);
    
    fetchComputeExtreme();
    // Call rewards() function
    //await collectRewards();
    await closePosition();
    }
    else{
     
      console.log("price in range!")
    }
  }
  

  console.log("Get SOL balance:")
  const solBalance = await getSolBalance();
  console.log("SOL Balance:", solBalance);
  console.log("Sleep!")
      await sleep(500);



  console.log("Get USDC Balance:")
  let usdcBalance = await getUSDCBalance();
  console.log("USDC Balance:", usdcBalance);
  console.log("Sleep!")
      await sleep(500);

  const solUSDCValue = solBalance * solPrice;
  console.log("SOL USDC Value:", solUSDCValue);
  
  const remainingBalanceSum = solUSDCValue + usdcBalance;
  console.log("Remaining USDC Value:", remainingBalanceSum);
  
  // Check condition for taking rewards and closing position if the position is not updated correctly
  if (POSITION !== "" && remainingBalanceSum > 3000) {
    console.log("Taking rewards and closing position!");
    fetchComputeExtreme();
    await rewards().catch(console.error);
    fetchComputeExtreme();
    await closePosition();
  }

  const diff = solUSDCValue - usdcBalance;
  console.log("SOL USDC Value Diff:", diff);

  const solAmountToSwap = (diff / solPrice / 2).toFixed(SOL.decimals);
  const usdcAmountToSwap = (diff / 2).toFixed(USDC.decimals);

  console.log("SOL amt swap:", solAmountToSwap);
  console.log("USDC amt swap:", usdcAmountToSwap);
  console.log("Sleep!")
      await sleep(500);

  

  if (POSITION === "") {

    console.log("Swap")
    if (diff > 300) {
      fetchComputeExtreme();
      await performSwap(Math.abs(Number(solAmountToSwap)*1000), SOL, "SOL", "USDC");
      console.log("Sleep!")
          await sleep(500);
      
    } else if (diff < -300) {
      fetchComputeExtreme();
      const usdcAmountToSwap_abs = Math.abs(Number(usdcAmountToSwap) / 1000).toFixed(USDC.decimals);
      await performSwap(usdcAmountToSwap_abs, USDC, "USDC", "SOL");
      console.log("Sleep!")
          await sleep(500);

    } else {
      console.log("Too small to swap!");
    }

    usdcBalance = await getUSDCBalance();
    console.log("USDC Balance:", usdcBalance);
    console.log("Sleep!")
        await sleep(500);
    console.log("Open Pos:")
    usdcBalance = await getUSDCBalance();
    fetchComputeExtreme();
    await openPosition(usdcBalance*PERCENTPOS,solPrice);
    console.log("Sleep!")
        await sleep(500);

  } else {
    console.log(" Already open position");
    
  }
  
  
}

async function loop() {
  while (true) {
    try {
      await main();
      console.log("Position : ", POSITION);
      if (POSITION === "") { // Corrected the assignment to comparison
        console.log("awaiting 10 min!");
        await sleep(60000); // Corrected sleep time to 10 seconds
      } else {
        console.log("awaiting 10 min!");
        await sleep(60000);
      }
    } catch (error) {
      console.error("An error occurred:", error);
      // Handle the error, log it, and continue the loop after some delay if needed
      await sleep(10000); // Optional: add a delay before retrying
    }
  }
}


loop();