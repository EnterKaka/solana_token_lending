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

export const refreshReserveInstruction = (
  programID : PublicKey,
  reserve: PublicKey,
  oracle?: PublicKey,
  switchboardFeedAddress?: PublicKey,
): TransactionInstruction => {
  const dataLayout = BufferLayout.struct([BufferLayout.u8('instruction')]);

  const data = Buffer.alloc(dataLayout.span);
  dataLayout.encode({ instruction: LendingInstruction.RefreshReserve }, data);

  const keys = [{ pubkey: reserve, isSigner: false, isWritable: true }];

  if (oracle) {
    keys.push({ pubkey: oracle, isSigner: false, isWritable: false });
  }

  if (switchboardFeedAddress) {
    keys.push({
      pubkey: switchboardFeedAddress,
      isSigner: false,
      isWritable: false,
    });
  }

  keys.push({
    pubkey: SYSVAR_CLOCK_PUBKEY,
    isSigner: false,
    isWritable: false,
  });

  return new TransactionInstruction({
    keys,
    programId: programID,
    data,
  });
};
