import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import * as Layout from '../../layout';
import { LendingInstruction } from './instruction';
const BufferLayout = require('buffer-layout')

export const repayObligationLiquidityInstruction = (
  programID : PublicKey,
  liquidityAmount : number | BN,
  sourceLiquidity : PublicKey,
  destinationLiquidity : PublicKey,
  repayReserve : PublicKey,
  obligation : PublicKey,
  lendingMarket : PublicKey,
  transferAuthority : PublicKey,
) : TransactionInstruction => {
  const dataLayout = BufferLayout.struct([
    BufferLayout.u8('instruction'),
    Layout.uint64('liquidityAmount'),
  ])
  const data = Buffer.alloc(dataLayout.span)
  dataLayout.encode(
    {
      instruction: LendingInstruction.RepayObligationLiquidity,
      liquidityAmount: new BN(liquidityAmount),
    },
    data,
  )

  const keys = [
    { pubkey: sourceLiquidity, isSigner: false, isWritable: true },
    { pubkey: destinationLiquidity, isSigner: false, isWritable: true },
    { pubkey: repayReserve, isSigner: false, isWritable: true },
    { pubkey: obligation, isSigner: false, isWritable: true },
    { pubkey: lendingMarket, isSigner: false, isWritable: false },
    { pubkey: transferAuthority, isSigner: true, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },    
  ]
  return new TransactionInstruction({
    keys,
    programId: programID,
    data,
  });  
}