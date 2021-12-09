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

export const depositObligationCollateralInstruction = (
  programID : PublicKey,
  collateralAmount : number | BN,
  sourceCollateral : PublicKey,
  destinationCollateral : PublicKey,
  depositReserve : PublicKey,
  obligation : PublicKey,
  lendingMarket : PublicKey,
  obligationOwner : PublicKey,
  transferAuthority : PublicKey,
) : TransactionInstruction => {
  const dataLayout = BufferLayout.struct([
    BufferLayout.u8('instruction'),
    Layout.uint64('collateralAmount'),
  ])
  const data = Buffer.alloc(dataLayout.span)
  dataLayout.encode(
    {
      instruction: LendingInstruction.DepositObligationCollateral,
      collateralAmount: new BN(collateralAmount),
    },
    data,
  )

  const keys = [
    { pubkey: sourceCollateral, isSigner: false, isWritable: true },
    { pubkey: destinationCollateral, isSigner: false, isWritable: true },
    { pubkey: depositReserve, isSigner: false, isWritable: true },
    { pubkey: obligation, isSigner: false, isWritable: true },
    { pubkey: lendingMarket, isSigner: false, isWritable: false },
    { pubkey: obligationOwner, isSigner: true, isWritable: true },
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