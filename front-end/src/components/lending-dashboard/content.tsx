import { Fragment, useRef, useState, useEffect } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import {
  Connection,
  Keypair,
  Signer,
  PublicKey,
  Transaction,
  TransactionSignature,
  ConfirmOptions,
  sendAndConfirmRawTransaction,
  RpcResponseAndContext,
  SimulatedTransactionResponse,
  Commitment,
  LAMPORTS_PER_SOL,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram
} from '@solana/web3.js';
import * as splToken from '@solana/spl-token';
import * as anchor from '@project-serum/anchor';
import { useWallet, WalletProvider, ConnectionProvider } from '@solana/wallet-adapter-react';
import CircularProgress from '@mui/material/CircularProgress';
import { getATAAddress } from '@saberhq/token-utils';
import moment from 'moment';
import useNotify from './notify';
import { Timer } from './timer';
import {
  ReserveParser, 
  RESERVE_LEN,
  getTotalLiquidityAmount,
  WAD
} from './models/layouts/reserve';

import {
  redeemReserveCollateralInstruction,
  depositReserveLiquidityInstruction,
  initObligationInstruction,
  refreshObligationInstruction,
  depositObligationCollateralInstruction,
  withdrawObligationCollateralInstruction,
  borrowObligationLiquidityInstruction,
  repayObligationLiquidityInstruction,
} from './models/instructions'

import {
  ObligationParser,OBLIGATION_LEN
} from './models/layouts/obligation'
import BigNumber from 'bignumber.js';
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
let notify: any;
let wallet : any;

let locked_users: any[] = [];

let netApy = 0;

let selLockAccount = {
  idx : 0,
  img : '',
  address : new PublicKey(0),
  amount : 0,
  ended_at : 0,
  time_left : {days:0,hours:0,minutes:0,seconds:0},
  end_day : '',//{year:0,month:0,days:0,hours:0,minutes:0,seconds:0},
  obligation : new PublicKey(0),
  reserve : new PublicKey(0),
  sourceCollateral : new PublicKey(0),
  teamWallet : new PublicKey(0),
}
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
const market_data = require('./production.json')
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');

let reserves : any[] = [];
let obligation  : any;
const programId = new PublicKey(market_data.programID)
const market = new PublicKey(market_data.markets.address)
const marketAuthority = new PublicKey(market_data.markets.authorityAddress)
let lending_balance = 0;
let borrow_balance = 0;

export async function getAssociatedTokenAddress(mint: any, owner: any) {
  let [address] = await PublicKey.findProgramAddress(
    [owner.toBuffer(), splToken.TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

export async function getObligationAddress(owner : PublicKey){
  let address = await PublicKey.createWithSeed(owner, 'obligation', programId)
  return address
}

async function getReserveData(){
  reserves.splice(0,reserves.length)
  for(let reserve of market_data.markets.reserves){
      const reserveAddress = new PublicKey(reserve.address)
      const asset = reserve.asset
      const resp = await conn.getAccountInfo(reserveAddress)
      if(resp == null) continue;
      let reserveData = ReserveParser(reserveAddress,resp!)
      let availableAmount =  reserveData!.info.liquidity.availableAmount.toNumber()
      let borrowedAmount = (new BigNumber(reserveData!.info.liquidity.borrowedAmountWads.toString())).dividedBy(WAD).toNumber()
      let currentUtilization = borrowedAmount / (availableAmount + borrowedAmount)
      let optimalUtilization = reserveData!.info.config.optimalUtilizationRate / 100
      let borrowAPY;
      if(optimalUtilization === 1.0 || currentUtilization < optimalUtilization) {
        const normalizedFactor = currentUtilization / optimalUtilization
        const optimalBorrowRate = reserveData!.info.config.optimalBorrowRate / 100
        const minBorrowRate = reserveData!.info.config.minBorrowRate / 100
        borrowAPY = normalizedFactor * (optimalBorrowRate - minBorrowRate) + minBorrowRate
      } else {
        const normalizedFactor = (currentUtilization - optimalUtilization) / (1- optimalUtilization)
        const optimalBorrowRate = reserveData!.info.config.optimalBorrowRate / 100
        const maxBorrowRate = reserveData!.info.config.maxBorrowRate / 100
        borrowAPY = normalizedFactor * (maxBorrowRate - optimalBorrowRate) + optimalBorrowRate
      }
      let supplyAPY = borrowAPY * currentUtilization

      reserves.push({
        ...reserveData,
        asset,
        img : 'images/seeded_icon.svg',
        mintDecimals : reserveData!.info.liquidity.mintDecimals,
        availableAmount : availableAmount,
        borrowedAmount : borrowedAmount,
        marketPrice : (new BigNumber(reserveData!.info.liquidity.marketPrice.toString())).dividedBy(WAD).toNumber(),
        borrowAPY : borrowAPY * 100,
        supplyAPY : supplyAPY * 100,
        accrue : ((new BigNumber(reserveData!.info.liquidity.cumulativeBorrowRateWads.toString())).dividedBy(WAD).toNumber()-1)*100,
      })
  }
}

let lendData = {
  idx: 0,
  asset: '',
  price: 0,
  walletBalance: 0,
  apy: 0,
  lendBalance: 0,
  collateralFactor: 0,
  decimals: 0,
  limit: 0,
  usedLimit: 0,
};

async function getLendData(idx : number){
  if(!wallet) return;
  let reserve = reserves[idx]
  lendData.idx = idx;
  lendData.asset = reserve.asset
  lendData.price = reserve.marketPrice
  lendData.apy = reserve.supplyAPY
  lendData.collateralFactor = reserve.info.config.loanToValueRatio
  lendData.decimals = reserve.mintDecimals

  let owner = wallet.publicKey
  if(reserve.asset != 'SOL'){
    let mintAddress = reserve.info.liquidity.mintPubkey;
    let tokenAddress = await getAssociatedTokenAddress(mintAddress,owner)
    let walletBalance = 0
    if(await conn.getAccountInfo(tokenAddress)){
      let temp = (await conn.getTokenAccountBalance(tokenAddress)).value as any
      walletBalance = temp.uiAmount
    }
    lendData.walletBalance = walletBalance
  } else {
    lendData.walletBalance = (await conn.getBalance(owner))/Math.pow(10,9)
  }
  lendData.lendBalance = 0
  if(obligation){
    for(let deposit of obligation.info.deposits){
      if(reserve.pubkey.toBase58()==deposit.depositReserve.toBase58()){
        lendData.lendBalance = deposit.depositedAmount.toNumber() / Math.pow(10,reserve.mintDecimals)
        break;
      }
    }
  }  
}

let borrowData = {
  idx: 0,
  asset: '',
  price: 0,
  walletBalance: 0,
  apy: 0,
  borrowBalance: 0,
  accruedInterest: 0,
  limit: 0,
  limitBalance: 0,
  decimals: 0,
  usedLimit: 0,
};

async function getBorrowData(idx : number){
  if(!wallet) return;
  let reserve = reserves[idx]
  borrowData.idx = idx;
  borrowData.asset = reserve.asset
  borrowData.price = reserve.marketPrice
  borrowData.apy = reserve.borrowAPY
  borrowData.decimals = reserve.mintDecimals
  borrowData.accruedInterest = reserve.accrue
  if(obligation){
    for(let borrow of obligation.info.borrows) {
      borrowData.borrowBalance = (new BigNumber(borrow.borrowedAmountWads.toString)).dividedBy(WAD).toNumber() / Math.pow(10,reserve.mintDecimals)
      console.log(reserve.accrue)
    }
  }
}

let lended_items: any[] = [];
let borrow_items: any[] = [];

async function getObligationData(){
  lended_items.splice(0,lended_items.length)
  borrow_items.splice(0,borrow_items.length)
  lending_balance = 0
  borrow_balance = 0
  obligation = null
  if(!wallet || wallet.connected == false) return;
  let obligationAddress = await getObligationAddress(wallet.publicKey)
  let resp = await conn.getAccountInfo(obligationAddress)
  if(resp == null) return;
  let obligationData = ObligationParser(obligationAddress,resp)
  obligation = obligationData

  for(let deposit of obligation.info.deposits){
    let balance = deposit.depositedAmount.toNumber()
    if(balance == 0) continue;
    for(let reserve of reserves){
      if(reserve.pubkey.toBase58() == deposit.depositReserve.toBase58()){
        lended_items.push({
          img : reserve.img,
          asset : reserve.asset,
          apy : reserve.supplyAPY,
          balance :  balance / Math.pow(10,reserve.mintDecimals),
          collateralFactor : reserve.info.config.loanToValueRatio
        })
        break;
      }
    }
  }

  for(let borrow of obligation.info.borrows) {
    let balance = (new BigNumber(borrow.borrowedAmountWads.toString)).dividedBy(WAD).toNumber()
    if(balance == 0) continue;
    for(let reserve of reserves){
      if(reserve.pubkey.toBase58() == borrow.borrowReserve.toBase58()){

        borrow_items.push({
          img : reserve.img,
          asset : reserve.asset,
          apy : reserve.supplyAPY,
          balance : balance / Math.pow(10,reserve.mintDecimals),
          borrowLimit : 0,
        })
        break;
      }
    }
  }

  lending_balance = (new BigNumber(obligationData!.info.depositedValue.toString())).dividedBy(WAD).toNumber()
  borrow_balance = (new BigNumber(obligationData!.info.borrowedValue.toString())).dividedBy(WAD).toNumber()
}

async function createTokenAccountInstruction(mint : PublicKey){
  let ata = await getAssociatedTokenAddress(mint, wallet.publicKey)
  return (
    await splToken.Token.createAssociatedTokenAccountInstruction(
      splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
      splToken.TOKEN_PROGRAM_ID,
      mint,
      ata,
      wallet.publicKey,
      wallet.publicKey,
    )
  )
}

async function createObligation(transaction : Transaction){
  const rent = await conn.getMinimumBalanceForRentExemption(OBLIGATION_LEN)
  let obligation = await getObligationAddress(wallet.publicKey)

  transaction.add(
    SystemProgram.createAccountWithSeed({
      basePubkey : wallet.publicKey,
      fromPubkey : wallet.publicKey,
      seed : 'obligation',
      newAccountPubkey : obligation,
      lamports : rent,
      space : OBLIGATION_LEN,
      programId : programId,
    })
  )
  console.log(obligation.toBase58())
  transaction.add(
    await initObligationInstruction(
      programId,
      obligation,
      market,
      wallet.publicKey,
    )
  )  
}

async function lend(amount : number){
  console.log("+ Lend")
  try {
    // let transaction = new Transaction()
    let signers : Keypair[] = []
    let reserve = reserves[lendData.idx]
    let liquidityAmount = amount * Math.pow(10, reserve.mintDecimals)

    let sourceLiquidity = await getAssociatedTokenAddress(reserve.info.liquidity.mintPubkey,wallet.publicKey)
    if((await conn.getAccountInfo(sourceLiquidity)) == null){
      let transaction = new Transaction()
      transaction.add(await createTokenAccountInstruction(reserve.info.liquidity.mintPubkey))
      await sendTransaction(transaction,[])
    }

    let destinationCollateral = await getAssociatedTokenAddress(reserve.info.collateral.mintPubkey,wallet.publicKey)
    if((await conn.getAccountInfo(destinationCollateral)) == null){
      let transaction = new Transaction()
      transaction.add(await createTokenAccountInstruction(reserve.info.collateral.mintPubkey))
      await sendTransaction(transaction,[])
    }   

    let obligation = await getObligationAddress(wallet.publicKey)
    const rent = await conn.getMinimumBalanceForRentExemption(OBLIGATION_LEN)
    console.log(obligation.toBase58())
    if((await conn.getAccountInfo(obligation)) == null){
      let transaction1 = new Transaction()

      transaction1.add(
        SystemProgram.createAccountWithSeed({
          basePubkey : wallet.publicKey,
          fromPubkey : wallet.publicKey,
          seed : 'obligation',
          newAccountPubkey : obligation,
          lamports : rent,
          space : OBLIGATION_LEN,
          programId : programId,
        })
      )
      await sendTransaction(transaction1,[])
      let transaction2 = new Transaction()
      transaction2.add(
        await initObligationInstruction(
          programId,
          obligation,
          market,
          wallet.publicKey,
        )        
      )
      await sendTransaction(transaction2,[])
    }


    let transaction = new Transaction()
    let transferAuthority = Keypair.generate()
    transaction.add(
      splToken.Token.createApproveInstruction(
        splToken.TOKEN_PROGRAM_ID,
        sourceLiquidity,
        transferAuthority.publicKey,
        wallet.publicKey,
        [],
        liquidityAmount
      )
    )
    transaction.add(
      depositReserveLiquidityInstruction(
        programId,
        liquidityAmount,
        sourceLiquidity,
        destinationCollateral,
        reserve.pubkey,
        reserve.info.liquidity.supplyPubkey,
        reserve.info.collateral.mintPubkey,
        market,
        marketAuthority,
        transferAuthority.publicKey,
      )
    )
    transaction.add(
      splToken.Token.createRevokeInstruction(splToken.TOKEN_PROGRAM_ID,sourceLiquidity,wallet.publicKey,[])
    )
    transaction.add(
      splToken.Token.createApproveInstruction(
        splToken.TOKEN_PROGRAM_ID,
        destinationCollateral,
        transferAuthority.publicKey,
        wallet.publicKey,
        [],
        liquidityAmount
      )
    )
    transaction.add(
      splToken.Token.createApproveInstruction(
        splToken.TOKEN_PROGRAM_ID,
        sourceLiquidity,
        transferAuthority.publicKey,
        wallet.publicKey,
        [],
        liquidityAmount
      )
    )
    transaction.add(
      depositObligationCollateralInstruction(
        programId,
        liquidityAmount,
        destinationCollateral,
        reserve.info.collateral.supplyPubkey,
        reserve.pubkey,
        obligation,
        market,
        wallet.publicKey,
        transferAuthority.publicKey
      )
    )
    transaction.instructions.map((inst)=>{
      console.log(inst.programId.toBase58())
    })
    transaction.add(
      splToken.Token.createRevokeInstruction(splToken.TOKEN_PROGRAM_ID,destinationCollateral,wallet.publicKey,[])
    )

    signers.push(transferAuthority)
    await sendTransaction(transaction,signers)

  } catch(err) {
    console.log(err)
  }
}

async function withdraw(amount : number){
  console.log("+ Withdraw")
  try {
    let transaction = new Transaction()
    let signers : Keypair[] = []
    let reserve = reserves[lendData.idx]
    let collateralAmount = amount * Math.pow(10,reserve.mintDecimals)
    let obligation = await getObligationAddress(wallet.publicKey)
    if((await conn.getAccountInfo(obligation)) == null){
      await createObligation(transaction)
    }
    let destinationCollateral = await getAssociatedTokenAddress(reserve.info.collateral.mintPubkey,wallet.publicKey)

    let destinationLiquidity = await getAssociatedTokenAddress(reserve.info.liquidity.mintPubkey, wallet.publicKey)

    let transferAuthority = Keypair.generate()

    transaction.add(
      withdrawObligationCollateralInstruction(
        programId,
        collateralAmount,
        reserve.info.liquidity.supplyPubkey,
        destinationCollateral,
        reserve.pubkey,
        obligation,
        market,
        marketAuthority,
        wallet.publicKey
      )
    )
    transaction.add(
      splToken.Token.createApproveInstruction(
        splToken.TOKEN_PROGRAM_ID,
        destinationCollateral,
        transferAuthority.publicKey,
        wallet.publicKey,
        [],
        collateralAmount,
      )
    )
    transaction.add(
      redeemReserveCollateralInstruction(
        programId,
        collateralAmount,
        destinationCollateral,
        destinationLiquidity,
        reserve.pubkey,
        reserve.info.collateral.mintPubkey,
        reserve.info.liquidity.supplyPubkey,
        market,
        marketAuthority,
        transferAuthority.publicKey,
      )
    )
    transaction.add(
      splToken.Token.createRevokeInstruction(splToken.TOKEN_PROGRAM_ID,destinationCollateral,wallet.publicKey,[])
    )
    signers.push(transferAuthority)
    sendTransaction(transaction,signers)
  } catch(err) {
    console.log(err)
  }
}

async function borrow(amount : number){
  console.log("+ Borrow")
  try {
    let transaction = new Transaction()
    let signers : Keypair[] = []
    let reserve = reserves[borrowData.idx]
    let liquidityAmount = amount * Math.pow(10, reserve.mintDecimals)
    let destinationLiquidity = await getAssociatedTokenAddress(reserve.info.liquidity.mintPubkey,wallet.pubkey)
    if((await conn.getAccountInfo(destinationLiquidity)) == null){
      transaction.add(
        await createTokenAccountInstruction(reserve.info.liquidity.mintPubkey)
      )
    }

    transaction.add(
      borrowObligationLiquidityInstruction(
        programId,
        liquidityAmount,
        reserve.info.liquidity.supplyPubkey,
        destinationLiquidity,
        reserve.pubkey,
        obligation,
        market,
        marketAuthority,
        wallet.publicKey,
      )
    )
    sendTransaction(transaction,signers)
  } catch(err) {
    console.log(err)
  }
}

async function repay(amount : number){
  console.log("+ Repay")
  try {
    let transaction = new Transaction()
    let signers : Keypair[] = []
    let reserve = reserves[borrowData.idx]
    let liquidityAmount = amount * Math.pow(10, reserve.mintDecimals)
    let sourceLiquidity = await getAssociatedTokenAddress(reserve.info.liquidity.mintPubkey,wallet.pubkey)
    if((await conn.getAccountInfo(sourceLiquidity)) == null){
      transaction.add(
        await createTokenAccountInstruction(reserve.info.liquidity.mintPubkey)
      )
    } 
    let transferAuthority = Keypair.generate()
    transaction.add(
      splToken.Token.createApproveInstruction(
        splToken.TOKEN_PROGRAM_ID,
        sourceLiquidity,
        transferAuthority.publicKey,
        wallet.publicKey,
        [],
        liquidityAmount
      )
    )
    transaction.add(
      repayObligationLiquidityInstruction(
        programId,
        liquidityAmount,
        sourceLiquidity,
        reserve.info.liquidity.supplyPubkey,
        reserve.pubkey,
        obligation,
        market,
        transferAuthority.publicKey,
      )
    )
    transaction.add(
      splToken.Token.createRevokeInstruction(splToken.TOKEN_PROGRAM_ID,sourceLiquidity,wallet.publicKey,[])
    )
    signers.push(transferAuthority)
    sendTransaction(transaction,signers)
  } catch(err) {
    console.log(err)
  }
}

async function sendTransaction(transaction : Transaction,signers : Keypair[]) {
  try{
    transaction.feePayer = wallet.publicKey
    transaction.recentBlockhash = (await conn.getRecentBlockhash('max')).blockhash;
    await transaction.setSigners(wallet.publicKey)
    await transaction.setSigners(wallet.publicKey,...signers.map(s => s.publicKey));
    if(signers.length != 0)
      await transaction.partialSign(...signers)
    const signedTransaction = await wallet.signTransaction(transaction);
    let hash = await conn.sendRawTransaction(await signedTransaction.serialize());
    await conn.confirmTransaction(hash);
    notify('success', 'Success!');
  } catch(err) {
    console.log(err)
    notify('error', 'Failed Instruction!');
  }
}

async function loadLending(callback : any, wallet : any){
    await getReserveData()
    // await getObligationData()
    console.log(reserves)
}

function roundValue(val: number, positionPoint: number) {
  return Math.round(val * Math.pow(10, positionPoint)) / Math.pow(10, positionPoint);
}

let init = true;
export default function Content() {
  const [lendopen, setLendOpen] = useState(false);
  const [borrowopen, setBorrowOpen] = useState(false);
  const [lockopen, setLockOpen] = useState(false);
  const [lendtabshow, setLendTabShow] = useState('lend');
  const [borrowtabshow, setBorrowTabShow] = useState('borrow');
  const [changed, setChange] = useState(true);
  const [amount1, setAmount1] = useState(0.0);
  const [amount2, setAmount2] = useState(0.0);
  const [amount3, setAmount3] = useState(0.0);
  const [amount4, setAmount4] = useState(0.0);
  const [validValue, setValidValue] = useState(false);
  const [progress, setProgress] = useState(0);
  const [assetlock , setAssetLock] = useState(false);
  wallet = useWallet();
  // console.log(wallet.publicKey?.toBase58());

  notify = useNotify();
  const lendCancelButtonRef = useRef(null);
  const borrowCancelButtonRef = useRef(null);
  const lockCancelButtonRef = useRef(null);
  const changeValue1 = (event: any) => {
    if (event.target.value > lendData.walletBalance) {
      setAmount1(0);
      setValidValue(true);
    } else {
      setValidValue(false);
      setAmount1(event.target.value);
    }
  };

  const changeValue2 = (event: any) => {
    if (event.target.value > lendData.lendBalance) {
      setAmount2(0);
      setValidValue(true);
    } else {
      setValidValue(false);
      setAmount2(event.target.value);
    }
  };

  const changeValue3 = (event: any) => {
    if (event.target.value > borrowData.limitBalance) {
      setAmount3(0);
      setValidValue(true);
    } else {
      setValidValue(false);
      setAmount3(event.target.value);
    }
  };

  const changeValue4 = (event: any) => {
    if (event.target.value > borrowData.borrowBalance) {
      setAmount4(0);
      setValidValue(true);
    } else {
      setValidValue(false);
      setAmount4(event.target.value);
    }
  };

  const reRender = () => {
    setChange(!changed);
  };
  const lendModal = () => {
    setLendOpen(true);
  };
  const borrowModal = () => {
    setBorrowOpen(true);
  };
  const lockModal = () => {
    setLockOpen(true);
  };

  const changeCircle = () => {
    setProgress(99);
    if (wallet.publicKey != undefined) {
      loadLending(reRender, wallet.publicKey);
    }
  };

  if (wallet.publicKey != undefined && init) {
    init = false;
    loadLending(reRender, wallet.publicKey);
  }

  if (wallet.connected == false && init == false) {
    init = true;
    loadLending(reRender, null);
  }

  useEffect(() => {
    const timer = setInterval(() => {
      setProgress((prevProgress) => (prevProgress >= 100 ? 0 : prevProgress + 0.167));
    }, 1000);

    const timer1 = setInterval(() => {
      if (wallet.publicKey != undefined) {
        loadLending(reRender, wallet.publicKey);
      }
    }, 650000);

    return () => {
      clearInterval(timer);
      clearInterval(timer1);
    };
  }, []);

  return (
    <div className='z-10'>
      <div className='absolute circle mouse-cursor' onClick={() => changeCircle()}>
        <CircularProgress
          variant='determinate'
          value={100}
          sx={{
            color: '#313131',
          }}
          size={40}
          thickness={4}
          className='absolute right-0'
        />
        <CircularProgress
          variant='determinate'
          value={progress}
          sx={{
            color: '#0CF3A8',
          }}
          size={40}
          thickness={4}
        />
      </div>
      <div className='flex items-center justify-center -mt-8'>
        <img src={'images/circle.svg'} className='circle-width' alt='circle' />
      </div>
      <div className='top-layout'>
        <div className='net-color'>Net APY</div>
        <div className='percent-color'>{netApy}%</div>
      </div>
      <div className='flex justify-between title-layout'>
        <div className='l-bal text-left'>
          <span className='title-style'>Lend balance</span>
          <br />
          {wallet.connected ? (
            <span className='text-sm l-color'>${roundValue(lending_balance, 4)}</span>
          ) : (
            <span></span>
          )}
        </div>
        <div className='b-bal text-right'>
          <span className='title-style'>Borrow balance</span>
          <br />
          {wallet.connected ? <span className='text-sm b-color'>${roundValue(borrow_balance, 4)}</span> : <span></span>}
        </div>
      </div>
      <div className='bottom-layout'>
        <div className='dashboard-layout'>
          <div>
            <div className='flex justify-between gap-10'>
              <div className='lended-part rounded-xl p-12 text-right'>
                <div className='flex justify-between title-font'>
                  <div className='w-1/6 text-left'>LENDED</div>
                  <div className='w-1/6'>APY</div>
                  <div className='w-2/6'>BALANCE</div>
                  <div className='w-2/6'>COLLATERAL</div>
                </div>
                {lended_items.map((item, idx) => (
                  <div className='flex justify-between content-font' key={idx}>
                    <div className='w-1/6 flex justify-first'>
                      <img src={item.img} alt='sol' className='w-5' />
                      <div className='ml-2'>{item.asset}</div>
                    </div>
                    <div className='w-1/6'>{roundValue(item.apy,2)}% </div>
                    <div className='w-2/6'>${roundValue(item.balance, 4)}</div>
                    <div className='w-2/6'>{roundValue(item.collateralFactor, 2)}%</div>
                  </div>
                ))}
{/*                <div className='flex justify-between title-font-lock'>
                  <div className='w-1/6 text-left'>LOCKED</div>
                  <div className='w-1/6'>Time left</div>
                  <div className='w-1/6'>AMOUNT</div>
                  <div className='w-1/6'>RESERVE</div>
                  <div className='w-2/6'></div>
                </div>
                {locked_users.map((item, idx) => (
                  <div className='flex justify-between items-center content-font' key={idx}>
                    <div className='w-1/6 flex justify-first'>
                      <img src={item.img} alt='sol' className='w-5' />
                      <div className='ml-2'>{item.asset}</div>
                    </div>
                    <div className='w-1/6'>{item.end_day}</div>
                    <div className='w-1/6'>{item.amount}</div>
                    <div className='w-1/6'>{item.reserve.toBase58().substr(0,5)}</div>
                    <div className='w-2/6'>
                      <button className='custom-button-lock' type='button' onClick={async () => {
                        await selectLockAccount(idx)
                        lockModal()
                      }}>
                        Unlock
                      </button>
                    </div>
                  </div>
                ))}*/}
              </div>
              <div className='borrow-part rounded-xl p-12 text-right'>
                <div className='flex justify-between title-font'>
                  <div className='w-1/6 text-left'>BORROWED</div>
                  <div className='w-1/6'>APY</div>
                  <div className='w-2/6'>BALANCE</div>
                  <div className='w-2/6'>BORROW LIMIT</div>
                </div>
                {borrow_items.map((item, idx) => (
                  <div className='flex justify-between content-font' key={idx}>
                    <div className='w-1/6 flex justify-first'>
                      <img src={item.img} alt='sol' className='w-5' />
                      <div className='ml-2'>{item.asset}</div>
                    </div>
                    <div className='w-1/6'>{roundValue(item.apy,2)}%</div>
                    <div className='w-2/6'>${roundValue(item.balance, 4)}</div>
                    <div className='w-2/6'>${roundValue(item.borrowLimit, 4)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className='mt-12'>
            <div className='flex justify-between gap-10'>
              <div className='asset-part rounded-xl text-right'>
                <div className='text-left mb-4 asset-title'>
                  <span className='text-xl'>Lend assets</span>
                </div>
                <div className='custom-border-bottom'></div>
                <div className='flex justify-between asset-title-font'>
                  <div className='w-2/12 text-left'>ASSET</div>
                  <div className='w-3/12'>LIQUIDITY</div>
                  <div className='w-3/12'>REWARD APY</div>
                  <div className='w-4/12'>IN BALANCE</div>
                </div>
                {reserves.map((item, idx) => (
                  <div className='asset-border' key={idx}>
                    <div
                      className='flex justify-between seeded-content-font'
                      onClick={async () => {
                        if (wallet.connected) {
                          await getLendData(idx);
                          lendModal();
                        }
                      }}>
                      <div className='w-2/12 flex justify-first'>
                        <img src={item.img} alt='sol' className='w-5' />
                        <div className='ml-2'>{item.asset}</div>
                      </div>
                      <div className='w-3/12'>
                        ${
                          roundValue((item.availableAmount + item.borrowedAmount)/Math.pow(10,item.mintDecimals)*item.marketPrice,2)
                        }
                      </div>
                      <div className='w-3/12'>
                        {
                          roundValue(item.supplyAPY,2)
                        }%
                      </div>
                      <div className='w-4/12'>
                        {
                          roundValue((item.availableAmount + item.borrowedAmount)/Math.pow(10,item.mintDecimals),2) + item.asset
                        }
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className='asset-part rounded-xl text-right'>
                <div className='text-left mb-4 asset-title'>
                  <span className='text-xl'>Borrow assets</span>
                </div>
                <div className='custom-border-bottom'></div>
                <div className='flex justify-between asset-title-font'>
                  <div className='w-2/12 text-left'> ASSET</div>
                  <div className='w-3/12'>BORROWED</div>
                  <div className='w-3/12'>REWARD APY</div>
                  <div className='w-4/12'>IN BALANCE</div>
                </div>
                {reserves.map((item, idx) => (
                  <div className='asset-border' key={idx}>
                    <div
                      className='flex justify-between seeded-content-font'
                      onClick={async () => {
                        if (wallet.connected) {
                          await getBorrowData(idx)
                          borrowModal();
                        }
                      }}>
                      <div className='w-2/12 flex justify-first'>
                        <img src={item.img} alt='sol' className='w-5' />
                        <div className='ml-2'>{item.asset}</div>
                      </div>
                      <div className='w-3/12'>
                        ${
                          roundValue((item.borrowedAmount)/Math.pow(10,item.mintDecimals)*item.marketPrice,2)
                        }
                      </div>
                      <div className='w-3/12'>
                        {
                          roundValue(item.borrowAPY,2)
                        }%
                      </div>
                      <div className='w-4/12'>
                        {
                          roundValue((item.borrowedAmount)/Math.pow(10,item.mintDecimals),2) + item.asset
                        }
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <Transition.Root show={lendopen} as={Fragment}>
              <Dialog
                as='div'
                className='fixed z-10 inset-0 overflow-y-auto'
                initialFocus={lendCancelButtonRef}
                onClose={setLendOpen}>
                <div className='flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0'>
                  <Transition.Child
                    as={Fragment}
                    enter='ease-out duration-300'
                    enterFrom='opacity-0'
                    enterTo='opacity-100'
                    leave='ease-in duration-200'
                    leaveFrom='opacity-100'
                    leaveTo='opacity-0'>
                    <Dialog.Overlay className='fixed inset-0 bg-gray-700 bg-opacity-75 transition-opacity' />
                  </Transition.Child>

                  {/* This element is to trick the browser into centering the modal contents. */}
                  <span className='hidden sm:inline-block sm:align-middle sm:h-screen' aria-hidden='true'>
                    &#8203;
                  </span>
                  <Transition.Child
                    as={Fragment}
                    enter='ease-out duration-300'
                    enterFrom='opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95'
                    enterTo='opacity-100 translate-y-0 sm:scale-100'
                    leave='ease-in duration-200'
                    leaveFrom='opacity-100 translate-y-0 sm:scale-100'
                    leaveTo='opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95'>
                    <div className='inline-block align-bottom rounded-3xl overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full modal-body'>
                      <div className='flex justify-between py-4 px-9 custom-border-bottom'>
                        <div className={lendtabshow === 'lend' ? 'active-border-left' : 'active-border-right'}></div>
                        <div className='tab-lend text-base mouse-cursor' onClick={() => setLendTabShow('lend')}>
                          <span className={lendtabshow === 'lend' ? 'title-active' : ''}>Lend</span>
                        </div>
                        <div className='tab-withdraw text-base mouse-cursor' onClick={() => setLendTabShow('withdraw')}>
                          <span className={lendtabshow === 'withdraw' ? 'title-active' : ''}>Withdraw</span>
                        </div>
                      </div>
                      <div className={lendtabshow === 'lend' ? 'tab-show' : 'tab-hidden'}>
                        <div className='flex justify-between mb-4 mx-9 mt-9'>
                          <div className='modal-text'>AMOUNT</div>
                          <div className='modal-balance'>
                            <span>Wallet balance: </span>
                            <span className='unit-color'>
                              {roundValue(lendData.walletBalance, 4)} {lendData.asset}
                            </span>
                          </div>
                        </div>
                        <div className='flex justify-between my-2 mx-9'>
                          <input
                            type='text'
                            name='price'
                            id='price'
                            className='focus:ring-indigo-500 focus:border-indigo-500 block w-full pr-4 custom-input text-right'
                            // value='45.01'
                            // disabled={true}
                            // value={amount}
                            onChange={changeValue1}
                            placeholder=' 0.00'
                          />
                          <div className='custom-i-right'>
                            <div className='mt-2.5 parent-text'>{lendData.asset}</div>
                            <div className='sub-text'>~${roundValue(amount1 * lendData.price, 4)}</div>
                          </div>
                        </div>
                        {validValue ? <div className='text-left my-2 mx-9 text-xs warning'>INCORRECT AMOUNT</div> : ''}
                        <div className='modal-text text-left mt-9 mx-9'>LENDING INFO</div>
                        <div className='flex justify-between mt-4 mx-9 text-xs'>
                          <div>Wallet balance</div>
                          <div>
                            {roundValue(lendData.walletBalance, 4)} {lendData.asset}
                          </div>
                        </div>
                        <div className='flex justify-between my-2 mx-9 text-xs'>
                          <div>APY</div>
                          <div>{roundValue(lendData.apy,4)}%</div>
                        </div>
                        <div className='flex justify-between my-2 mx-9 text-xs'>
                          <div>Lend balance</div>
                          <div>
                            {roundValue(lendData.lendBalance, 4)} {lendData.asset}
                          </div>
                        </div>
                        <div className='flex justify-between my-2 mx-9 text-xs'>
                          <div>Collateral factor</div>
                          <div>{roundValue(lendData.collateralFactor, 4)}%</div>
                        </div>
                        <div className='modal-text text-left mt-9 mx-9'></div>
                        <div className='modal-text text-left mt-9 mx-9'>TOKEN LOCKING</div>
                        <div className='flex justify-between mt-4 mx-9 text-xs'>
                          <div>Duration locked</div>
                          <div>90 days</div>
                        </div>
                        <div className='flex justify-start modal-text mt-9 mb-4 mx-9' onClick={()=>{
                          setAssetLock(!assetlock)
                        }}>
                          {assetlock ? <img className='w-3.5 mouse-cursor' src='images/locked.svg' alt='sol' />
                            : <img className='w-3.5 mouse-cursor' src='images/unlocked.svg' alt='sol' />}
                        <div className='ml-2'>{assetlock ? 'Lend my tokens' : 'Lock my tokens'}</div>
                        </div>
                        <div className='mt-2 mb-14 mx-9'>
                          <button
                            className='custom-button'
                            type='button'
                            onClick={async () => {
                              if(!assetlock)
                                await lend(amount1);
                              // else
                              //   await lockAsset(amount1);
                              setAmount1(0);
                              setAssetLock(false);
                              setLendOpen(false)
                            }}>
                            {assetlock ? "Lock" : "Lend"}
                          </button>
                        </div>
                      </div>
                      <div className={lendtabshow === 'withdraw' ? 'tab-show' : 'tab-hidden'}>
                        <div className='flex justify-between mb-4 mx-9 mt-9'>
                          <div className='modal-text'>AMOUNT</div>
                          <div className='modal-balance'>
                            <span>Lend balance: </span>
                            <span className='unit-color'>
                              {roundValue(lendData.lendBalance, 7)} {lendData.asset}
                            </span>
                          </div>
                        </div>
                        <div className='flex justify-between my-2 mx-9'>
                          <input
                            type='text'
                            name='price'
                            id='price'
                            className='focus:ring-indigo-500 focus:border-indigo-500 block w-full pr-4 custom-input text-right'
                            // value={amount}
                            onChange={changeValue2}
                            placeholder=' 0.00'
                          />
                          <div className='custom-i-right'>
                            <div className='mt-2.5 parent-text'>{lendData.asset}</div>
                            <div className='sub-text'>~${roundValue(amount2 * lendData.price, 4)}</div>
                          </div>
                        </div>
                        {validValue ? <div className='text-left my-2 mx-9 text-xs warning'>INCORRECT AMOUNT</div> : ''}
                        <div className='modal-text text-left mt-9 mx-9'>LENDING INFO</div>
                        <div className='flex justify-between mt-4 mx-9 text-xs'>
                          <div>Wallet balance</div>
                          <div>
                            {roundValue(lendData.walletBalance, 4)} {lendData.asset}
                          </div>
                        </div>
                        <div className='flex justify-between my-2 mx-9 text-xs'>
                          <div>APY</div>
                          <div>{roundValue(lendData.apy,4)}%</div>
                        </div>
                        <div className='flex justify-between my-2 mx-9 text-xs'>
                          <div>Lend balance</div>
                          <div>
                            {roundValue(lendData.lendBalance, 4)} {lendData.asset}
                          </div>
                        </div>
                        <div className='modal-text text-left mt-9 mx-9'>BORROW LIMIT</div>
                        <div className='flex justify-between mt-4 mx-9 text-xs'>
                          <div>Your limit</div>
                          <div>${roundValue(lendData.limit, 4)}</div>
                        </div>
                        <div className='flex justify-between mt-4 mx-9 text-xs'>
                          <div>Limit used</div>
                          <div>{roundValue(lendData.usedLimit, 4)}%</div>
                        </div>
                        <div className='mt-6 mb-14 mx-9'>
                          <button
                            className='custom-button'
                            type='button'
                            onClick={async () => {
                              await withdraw(amount2);
                              setAmount2(0);
                              setLendOpen(false);
                            }}>
                            Withdraw
                          </button>
                        </div>
                      </div>
                    </div>
                  </Transition.Child>
                </div>
              </Dialog>
            </Transition.Root>
            <Transition.Root show={borrowopen} as={Fragment}>
              <Dialog
                as='div'
                className='fixed z-10 inset-0 overflow-y-auto'
                initialFocus={borrowCancelButtonRef}
                onClose={setBorrowOpen}>
                <div className='flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0'>
                  <Transition.Child
                    as={Fragment}
                    enter='ease-out duration-300'
                    enterFrom='opacity-0'
                    enterTo='opacity-100'
                    leave='ease-in duration-200'
                    leaveFrom='opacity-100'
                    leaveTo='opacity-0'>
                    <Dialog.Overlay className='fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity' />
                  </Transition.Child>

                  {/* This element is to trick the browser into centering the modal contents. */}
                  <span className='hidden sm:inline-block sm:align-middle sm:h-screen' aria-hidden='true'>
                    &#8203;
                  </span>
                  <Transition.Child
                    as={Fragment}
                    enter='ease-out duration-300'
                    enterFrom='opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95'
                    enterTo='opacity-100 translate-y-0 sm:scale-100'
                    leave='ease-in duration-200'
                    leaveFrom='opacity-100 translate-y-0 sm:scale-100'
                    leaveTo='opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95'>
                    <div className='inline-block align-bottom rounded-3xl overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full modal-body'>
                      <div className='flex justify-between py-4 px-9 custom-border-bottom'>
                        <div
                          className={
                            borrowtabshow === 'borrow' ? 'active-b-border-left' : 'active-b-border-right'
                          }></div>
                        <div className='tab-lend text-base mouse-cursor' onClick={() => setBorrowTabShow('borrow')}>
                          <span className={borrowtabshow === 'borrow' ? 'title-b-active' : ''}>Borrow</span>
                        </div>
                        <div className='tab-withdraw text-base mouse-cursor' onClick={() => setBorrowTabShow('repay')}>
                          <span className={borrowtabshow === 'repay' ? 'title-b-active' : ''}>Repay</span>
                        </div>
                      </div>
                      <div className={borrowtabshow === 'borrow' ? 'tab-show' : 'tab-hidden'}>
                        <div className='flex justify-between mb-4 mx-9 mt-9'>
                          <div className='modal-text'>AMOUNT</div>
                          <div className='modal-balance'>
                            <span>Borrow limit: </span>
                            {/* <span className='unit-color'>{Math.round(borrowData.limit * 100) / 100}</span> */}
                            <span className='unit-color'>
                              {roundValue(borrowData.limitBalance, 4)} {borrowData.asset}
                            </span>
                          </div>
                        </div>
                        <div className='flex justify-between my-2 mx-9'>
                          <input
                            type='text'
                            name='price'
                            id='price'
                            className='focus:ring-indigo-500 focus:border-indigo-500 block w-full pr-4 custom-input text-right'
                            // value={amount}
                            onChange={changeValue3}
                            placeholder=' 0.00'
                          />
                          <div className='custom-i-right'>
                            <div className='mt-2.5 parent-text'>{borrowData.asset}</div>
                            <div className='sub-text'>~${Math.round(amount3 * borrowData.price * 100) / 100}</div>
                          </div>
                        </div>
                        {validValue ? <div className='text-left my-2 mx-9 text-xs warning'>INCORRECT AMOUNT</div> : ''}
                        <div className='modal-text text-left mt-9 mx-9'>BORROWING INFO</div>
                        <div className='flex justify-between mt-4 mx-9 text-xs'>
                          <div>APY</div>
                          <div>{roundValue(borrowData.apy,2)}%</div>
                        </div>
                        <div className='flex justify-between my-2 mx-9 text-xs'>
                          <div>Borrow balance</div>
                          <div>
                            {roundValue(borrowData.borrowBalance, 4)} {borrowData.asset}
                          </div>
                        </div>
                        <div className='flex justify-between my-2 mx-9 text-xs'>
                          <div>Accrued interest</div>
                          <div>{roundValue(borrowData.accruedInterest,2)}%</div>
                        </div>
                        <div className='modal-text text-left mt-9 mx-9'>BORROW LIMIT</div>
                        <div className='flex justify-between mt-4 mx-9 text-xs'>
                          <div>Your limit</div>
                          <div>${roundValue(borrowData.limit, 4)}</div>
                        </div>
                        <div className='flex justify-between mt-4 mx-9 text-xs'>
                          <div>Limit used</div>
                          <div>{roundValue(borrowData.usedLimit, 4)}%</div>
                        </div>
                        <div className='mt-4 mb-14 mx-9'>
                          <button
                            className='custom-button'
                            type='button'
                            onClick={async () => {
                              if (wallet.connected) {
                                await borrow(amount3);
                                setAmount3(0);
                                setBorrowOpen(false);
                              }
                            }}>
                            Borrow
                          </button>
                        </div>
                      </div>
                      <div className={borrowtabshow === 'repay' ? 'tab-show' : 'tab-hidden'}>
                        <div className='flex justify-between mb-4 mx-9 mt-9'>
                          <div className='modal-text'>AMOUNT</div>
                          <div className='modal-balance'>
                            <span>Borrow balance: </span>
                            <span className='unit-color'>
                              {roundValue(borrowData.borrowBalance, 4)} {borrowData.asset}
                            </span>
                          </div>
                        </div>
                        <div className='flex justify-between my-2 mx-9'>
                          <input
                            type='text'
                            name='price'
                            id='price'
                            className='focus:ring-indigo-500 focus:border-indigo-500 block w-full pr-4 custom-input text-right'
                            // value={amount}
                            onChange={changeValue4}
                            placeholder=' 0.00'
                          />
                          <div className='custom-i-right'>
                            <div className='mt-2.5 parent-text'>{borrowData.asset}</div>
                            <div className='sub-text'>~${roundValue(amount4 * borrowData.price, 4)}</div>
                          </div>
                        </div>
                        {validValue ? <div className='text-left my-2 mx-9 text-xs warning'>INCORRECT AMOUNT</div> : ''}
                        <div className='modal-text text-left mt-9 mx-9'>BORROWING INFO</div>
                        <div className='flex justify-between mt-4 mx-9 text-xs'>
                          <div>APY</div>
                          <div>{roundValue(borrowData.apy,2)}%</div>
                        </div>
                        <div className='flex justify-between my-2 mx-9 text-xs'>
                          <div>Borrow balance</div>
                          <div>
                            {roundValue(borrowData.borrowBalance, 4)} {borrowData.asset}
                          </div>
                        </div>
                        <div className='flex justify-between my-2 mx-9 text-xs'>
                          <div>Accrued interest</div>
                          <div>{roundValue(borrowData.accruedInterest,2)}%</div>
                        </div>
                        <div className='modal-text text-left mt-9 mx-9'>BORROW LIMIT</div>
                        <div className='flex justify-between mt-4 mx-9 text-xs'>
                          <div>Your limit</div>
                          <div>${roundValue(borrowData.limit, 4)}</div>
                        </div>
                        <div className='flex justify-between mt-4 mx-9 text-xs'>
                          <div>Limit used</div>
                          <div>{roundValue(borrowData.usedLimit, 4)}%</div>
                        </div>
                        <div className='mt-6 mb-14 mx-9'>
                          <button
                            className='custom-button'
                            type='button'
                            onClick={async () => {
                              if (wallet.connected) {
                                await repay(amount4);
                                setAmount4(0);
                                setBorrowOpen(false);
                              }
                            }}>
                            Repay
                          </button>
                        </div>
                      </div>
                    </div>
                  </Transition.Child>
                </div>
              </Dialog>
            </Transition.Root>
          </div>
        </div>
      </div>
    </div>
  );
}
