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

export const refreshObligationInstruction = (
  programID : PublicKey,
  obligation: PublicKey,
  depositReserves: PublicKey[],
  borrowReserves: PublicKey[],
): TransactionInstruction => {
  const dataLayout = BufferLayout.struct([BufferLayout.u8('instruction')]);

  const data = Buffer.alloc(dataLayout.span);
  dataLayout.encode(
    { instruction: LendingInstruction.RefreshObligation },
    data,
  );

  const keys = [
    { pubkey: obligation, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
  ];

  depositReserves.forEach((depositReserve) => {
    keys.push({ pubkey: depositReserve, isSigner: false, isWritable: false });
  });

  borrowReserves.forEach((borrowReserve) => {
    keys.push({ pubkey: borrowReserve, isSigner: false, isWritable: false });
  });

  return new TransactionInstruction({
    keys,
    programId: programID,
    data,
  });
};
