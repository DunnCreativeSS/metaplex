#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';
import { program } from 'commander';
import * as anchor from '@project-serum/anchor';
import fetch from 'node-fetch';

import {
  chunks,
  fromUTF8Array,
  parseDate,
  parsePrice,
} from './helpers/various';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  CACHE_PATH,
  CONFIG_ARRAY_START,
  CONFIG_LINE_SIZE,
  EXTENSION_JSON,
  EXTENSION_PNG,
  CANDY_MACHINE_PROGRAM_ID,
  jarezi,
} from './helpers/constants';
import {
  getCandyMachineAddress,
  getProgramAccounts,
  loadCandyProgram,
  loadWalletKey,
  AccountAndPubkey,
} from './helpers/accounts';
import { Config } from './types';
import { upload } from './commands/upload';
import { verifyTokenMetadata } from './commands/verifyTokenMetadata';
import { generateConfigurations } from './commands/generateConfigurations';
import { loadCache, saveCache } from './helpers/cache';
import { mint } from './commands/mint';
import { signMetadata } from './commands/sign';
import {
  getAccountsByCreatorAddress,
  signAllMetadataFromCandyMachine,
} from './commands/signAll';
import log from 'loglevel';
import { createMetadataFiles } from './helpers/metadata';
import { createGenerativeArt } from './commands/createArt';
import { withdraw } from './commands/withdraw';
program.version('0.0.2');


programCommand('create_candy_machine')
  .option(
    '-p, --price <string>',
    'Price denominated in SOL or spl-token override',
    '1',
  )
  .option(
    '-t, --spl-token <string>',
    'SPL token used to price NFT mint. To use SOL leave this empty.',
  )
  .option(
    '-a, --spl-token-account <string>',
    'SPL token account that receives mint payments. Only required if spl-token is specified.',
  )
  .option(
    '-s, --sol-treasury-account <string>',
    'SOL account that receives mint payments.',
  )
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (directory, cmd) => {
    const {
      keypair,
      env,
      price,
      cacheName,
      splToken,
      splTokenAccount,
      solTreasuryAccount,
      rpcUrl,
    } = cmd.opts();

    let parsedPrice = parsePrice(price);
    const cacheContent = loadCache(cacheName, env);

    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadCandyProgram(walletKeyPair, env, rpcUrl);

    let wallet = walletKeyPair.publicKey;
    const remainingAccounts = [];
    if (splToken || splTokenAccount) {
      if (solTreasuryAccount) {
        throw new Error(
          'If spl-token-account or spl-token is set then sol-treasury-account cannot be set',
        );
      }
      if (!splToken) {
        throw new Error(
          'If spl-token-account is set, spl-token must also be set',
        );
      }
      const splTokenKey = new PublicKey(splToken);
      const splTokenAccountKey = new PublicKey(splTokenAccount);
      if (!splTokenAccount) {
        throw new Error(
          'If spl-token is set, spl-token-account must also be set',
        );
      }

      const token = new Token(
        anchorProgram[0].provider.connection,
        splTokenKey,
        TOKEN_PROGRAM_ID,
        walletKeyPair,
      );

      const mintInfo = await token.getMintInfo();
      if (!mintInfo.isInitialized) {
        throw new Error(`The specified spl-token is not initialized`);
      }
      const tokenAccount = await token.getAccountInfo(splTokenAccountKey);
      if (!tokenAccount.isInitialized) {
        throw new Error(`The specified spl-token-account is not initialized`);
      }
      if (!tokenAccount.mint.equals(splTokenKey)) {
        throw new Error(
          `The spl-token-account's mint (${tokenAccount.mint.toString()}) does not match specified spl-token ${splTokenKey.toString()}`,
        );
      }

      wallet = splTokenAccountKey;
      parsedPrice = parsePrice(price, 10 ** mintInfo.decimals);
      remainingAccounts.push({
        pubkey: splTokenKey,
        isWritable: false,
        isSigner: false,
      });
    }

    if (solTreasuryAccount) {
      wallet = new PublicKey(solTreasuryAccount);
    }

    const config = new PublicKey(cacheContent.program.config);
    const [candyMachine, bump] = await getCandyMachineAddress(
      config,
      cacheContent.program.uuid,
    );
    await anchorProgram[0].rpc.initializeCandyMachine(
      bump,
      {
        uuid: cacheContent.program.uuid,
        price: new anchor.BN(parsedPrice),
        itemsAvailable: new anchor.BN(Object.keys(cacheContent.items).length),
        goLiveDate: null,
      },
      {
        accounts: {
          candyMachine,
          wallet,
          config: config,
          authority: walletKeyPair.publicKey,
          payer: walletKeyPair.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        },
        signers: [],
        remainingAccounts,
      },
    );
    cacheContent.candyMachineAddress = candyMachine.toBase58();
    saveCache(cacheName, env, cacheContent);
    log.info(
      `create_candy_machine finished. candy machine pubkey: ${candyMachine.toBase58()}`,
    );
  });

  if (!fs.existsSync(CACHE_PATH)) {
    fs.mkdirSync(CACHE_PATH);
  }
  log.setLevel(log.levels.INFO);
  programCommand('upload')
    .argument(
      '<directory>',
      'Directory containing images named from 0-n',
      val => {
        return fs.readdirSync(`${val}`).map(file => path.join(val, file));
      },
    )
    .option('-n, --number <number>', 'Number of images to upload')
    .option(
      '-s, --storage <string>',
      'Database to use for storage (arweave, ipfs, aws)',
      'arweave',
    )
    .option(
      '--ipfs-infura-project-id <string>',
      'Infura IPFS project id (required if using IPFS)',
    )
    .option(
      '--ipfs-infura-secret <string>',
      'Infura IPFS scret key (required if using IPFS)',
    )
    .option(
      '--aws-s3-bucket <string>',
      '(existing) AWS S3 Bucket name (required if using aws)',
    )
    .option('--no-retain-authority', 'Do not retain authority to update metadata')
    .option('--no-mutable', 'Metadata will not be editable')
    .option(
      '-r, --rpc-url <string>',
      'custom rpc url since this is a heavy command',
    )
    .action(async (files: string[], options, cmd) => {
      const {
        number,
        keypair,
        env,
        cacheName,
        storage,
        ipfsInfuraProjectId,
        ipfsInfuraSecret,
        awsS3Bucket,
        retainAuthority,
        mutable,
        rpcUrl,
      } = cmd.opts();
  
      if (storage === 'ipfs' && (!ipfsInfuraProjectId || !ipfsInfuraSecret)) {
        throw new Error(
          'IPFS selected as storage option but Infura project id or secret key were not provided.',
        );
      }
      if (storage === 'aws' && !awsS3Bucket) {
        throw new Error(
          'aws selected as storage option but existing bucket name (--aws-s3-bucket) not provided.',
        );
      }
      if (!(storage === 'arweave' || storage === 'ipfs' || storage === 'aws')) {
        throw new Error(
          "Storage option must either be 'arweave', 'ipfs', or 'aws'.",
        );
      }
      const ipfsCredentials = {
        projectId: ipfsInfuraProjectId,
        secretKey: ipfsInfuraSecret,
      };
  
      const pngFileCount = files.filter(it => {
        return it.endsWith(EXTENSION_PNG);
      }).length;
      const jsonFileCount = files.filter(it => {
        return it.endsWith(EXTENSION_JSON);
      }).length;
  
      const parsedNumber = parseInt(number);
      const elemCount = parsedNumber ? parsedNumber : pngFileCount;
  
      if (pngFileCount !== jsonFileCount) {
        throw new Error(
          `number of png files (${pngFileCount}) is different than the number of json files (${jsonFileCount})`,
        );
      }
  
      if (elemCount < pngFileCount) {
        throw new Error(
          `max number (${elemCount})cannot be smaller than the number of elements in the source folder (${pngFileCount})`,
        );
      }
  
      log.info(`Beginning the upload for ${elemCount} (png+json) pairs`);
  
      const startMs = Date.now();
      log.info('started at: ' + startMs.toString());
      let warn = false;
      for (;;) {
        const successful = await upload(
          files,
          cacheName,
          env,
          keypair,
          elemCount,
          storage,
          retainAuthority,
          mutable,
          rpcUrl,
          ipfsCredentials,
          awsS3Bucket,
        );
  
        if (successful) {
          warn = false;
          break;
        } else {
          warn = true;
          log.warn('upload was not successful, rerunning');
        }
      }
      const endMs = Date.now();
      const timeTaken = new Date(endMs - startMs).toISOString().substr(11, 8);
      log.info(
        `ended at: ${new Date(endMs).toISOString()}. time taken: ${timeTaken}`,
      );
      if (warn) {
        log.info('not all images have been uploaded, rerun this step.');
      }
    });
if (!fs.existsSync(CACHE_PATH)) {
  fs.mkdirSync(CACHE_PATH);
}
log.setLevel(log.levels.INFO);

programCommand('withdraw')
  .option(
    '-d ,--dry',
    'Show Candy Machine withdraw amount without withdrawing.',
  )
  .option('-ch, --charity <string>', 'Which charity?', '')
  .option('-cp, --charityPercent <string>', 'Which percent to charity?', '0')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (directory, cmd) => {
    const { keypair, env, dry, charity, charityPercent, rpcUrl } = cmd.opts();
    if (charityPercent < 0 || charityPercent > 100) {
      log.error('Charity percentage needs to be between 0 and 100');
      return;
    }
    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = (await loadCandyProgram(walletKeyPair, env, rpcUrl))[0];
    const anchorProgram2 = (await loadCandyProgram(walletKeyPair, env, rpcUrl))[1];
    const configOrCommitment = {
      commitment: 'confirmed',
      filters: [
        {
         
        },
      ],
    };
    const configs = JSON.parse(fs.readFileSync("../rust/keys.txt").toString()).result
    let t = 0;
    for (const cg in configs) {
      try {
      if (configs[cg].account.lamports > LAMPORTS_PER_SOL * 10){
        const machine = await anchorProgram2.account.config.fetch(
        configs[cg].pubkey,
      );
      const candy_machine = await anchorProgram2.account.candyMachine.fetch(
       (await getCandyMachineAddress( new PublicKey(configs[cg].pubkey), machine.data.uuid))[0]
      );
      console.log(machine)
      console.log(candy_machine)
     
await      withdraw(
  (await getCandyMachineAddress( new PublicKey(configs[cg].pubkey), machine.data.uuid))[0],
  (await getCandyMachineAddress( new PublicKey(configs[cg].pubkey), machine.data.uuid, jarezi))[0],
  anchorProgram,
         walletKeyPair,
         configs[cg].pubkey,
         machine.authority,
         machine.data.uuid, 
         (await getCandyMachineAddress( new PublicKey(configs[cg].pubkey), machine.data.uuid, jarezi))[1], 
        255)

      }
      }
       catch (err){
        console.log(err)
       }
    }
  
  });


function programCommand(name: string) {
  return program
    .command(name)
    .option(
      '-e, --env <string>',
      'Solana cluster env name',
      'devnet', //mainnet-beta, testnet, devnet
    )
    .option(
      '-k, --keypair <path>',
      `Solana wallet location`,
      '--keypair not provided',
    )
    .option('-l, --log-level <string>', 'log level', setLogLevel)
    .option('-c, --cache-name <string>', 'Cache file name', 'temp');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function setLogLevel(value, prev) {
  if (value === undefined || value === null) {
    return;
  }
  log.info('setting the log value to: ' + value);
  log.setLevel(value);
}

program.parse(process.argv);
