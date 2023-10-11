import { PublicKey, Keypair } from '@solana/web3.js';
import * as anchor from '@project-serum/anchor';
import { sendTransactionWithRetryWithKeypair } from '../helpers/transactions';
import { Program } from '@project-serum/anchor';

export async function withdraw(
  candy_machine: any,
  candy_machine_jare: any,
  anchorProgram: Program,
  keypair: Keypair,
  configAddress: PublicKey,
  authority: PublicKey,
  uuid: String, 
  bump1: number, 
  bump2: number
): Promise<string> {
  const signers = [keypair];
  const instructions = [
    anchorProgram.instruction.withdrawFunds(bump1, bump2, uuid,{
      accounts: {
        
        authority2: keypair.publicKey,
        config: configAddress,
        authority,
        nftCandyMachine: new PublicKey("cndyAnrLdpjq1Ssp1z8xxDsB8dxe7u4HL5Nxi2K5WXZ"),
      candyMachine: candy_machine,
      candyMachineJare: candy_machine_jare
      },
    }),
  ];
  return (
    await sendTransactionWithRetryWithKeypair(
      anchorProgram.provider.connection,
      keypair,
      instructions,
      signers,
    )
  ).txid;
}
