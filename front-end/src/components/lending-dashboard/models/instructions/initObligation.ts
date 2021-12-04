import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import * as Layout from '../../layout';
import { LendingInstruction } from './instruction';
const BufferLayout = require('buffer-layout')

export const initObligationInstruction = (
  programID : PublicKey,
  obligation : PublicKey,
  lendingMarket : PublicKey,
  obligationOwner : PublicKey,
) : TransactionInstruction => {
  const dataLayout = BufferLayout.struct([
    BufferLayout.u8('instruction'),
  ])
  const data = Buffer.alloc(dataLayout.span)
  dataLayout.encode(
    {
      instruction : LendingInstruction.InitObligation,
    },
    data,
  )

  const keys = [
    {pubkey: obligation, isSigner: false, isWritable: true},
    {pubkey: lendingMarket, isSigner: false, isWritable: false},
    {pubkey: obligationOwner, isSigner: true, isWritable: true},
    {pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false},
    {pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false},
    {pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false},
  ]

  return new TransactionInstruction({
    keys,
    programId : programID,
    data,
  })
}