import { Chain } from "@chain-registry/types";
import { Panel } from "@namada/components";
import { AccountType } from "@namada/types";
import { params } from "App/routes";
import { TransferTransactionTimeline } from "App/Transactions/TransferTransactionTimeline";
import { isShieldedAddress } from "App/Transfer/common";
import {
  OnSubmitTransferParams,
  TransactionFee,
  TransferModule,
} from "App/Transfer/TransferModule";
import { allDefaultAccountsAtom } from "atoms/accounts";
import { namadaTransparentAssetsAtom } from "atoms/balance/atoms";
import { chainParametersAtom } from "atoms/chain/atoms";
import { applicationFeaturesAtom, rpcUrlAtom } from "atoms/settings";
import {
  createShieldedTransferAtom,
  createShieldingTransferAtom,
  createTransparentTransferAtom,
  createUnshieldingTransferAtom,
} from "atoms/transfer/atoms";
import BigNumber from "bignumber.js";
import clsx from "clsx";
import { useTransaction } from "hooks/useTransaction";
import { useTransactionActions } from "hooks/useTransactionActions";
import { wallets } from "integrations";
import { useAtomValue } from "jotai";
import { createTransferDataFromNamada } from "lib/transactions";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import namadaChain from "registry/namada.json";
import { twMerge } from "tailwind-merge";
import {
  Address,
  NamadaTransferTxKind,
  PartialTransferTransactionData,
  TransferStep,
} from "types";
import { isNamadaAsset } from "utils";
import { NamadaTransferTopHeader } from "./NamadaTransferTopHeader";

export const NamadaTransfer: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [displayAmount, setDisplayAmount] = useState<BigNumber | undefined>();
  const [shielded, setShielded] = useState<boolean>(true);
  const [customAddress, setCustomAddress] = useState<string>("");
  const [generalErrorMessage, setGeneralErrorMessage] = useState("");
  const [transaction, setTransaction] =
    useState<PartialTransferTransactionData>();

  const rpcUrl = useAtomValue(rpcUrlAtom);
  const features = useAtomValue(applicationFeaturesAtom);
  const chainParameters = useAtomValue(chainParametersAtom);
  const defaultAccounts = useAtomValue(allDefaultAccountsAtom);

  const { data: availableAssetsData, isLoading: isLoadingAssets } =
    useAtomValue(namadaTransparentAssetsAtom);

  const {
    transactions: myTransactions,
    findByHash,
    storeTransaction,
  } = useTransactionActions();

  const availableAssets = useMemo(() => {
    if (features.namTransfersEnabled) {
      return availableAssetsData;
    }
    const assetsMap = { ...availableAssetsData };
    const namadaAsset = Object.values(availableAssetsData ?? {}).find((a) =>
      isNamadaAsset(a.asset)
    );
    if (namadaAsset?.originalAddress) {
      delete assetsMap[namadaAsset?.originalAddress]; // NAM will be available only on phase 5
    }
    return assetsMap;
  }, [availableAssetsData]);

  const chainId = chainParameters.data?.chainId;
  const sourceAddress = defaultAccounts.data?.find((account) =>
    shielded ?
      account.type === AccountType.ShieldedKeys
    : account.type !== AccountType.ShieldedKeys
  )?.address;
  const selectedAssetAddress = searchParams.get(params.asset) || undefined;
  const selectedAsset =
    selectedAssetAddress ? availableAssets?.[selectedAssetAddress] : undefined;
  const token = selectedAsset?.originalAddress ?? "";
  const source = sourceAddress ?? "";
  const target = customAddress ?? "";
  const txAmount = displayAmount || new BigNumber(0);

  const commomProps = {
    parsePendingTxNotification: () => ({
      title: "Transfer transaction in progress",
      description: "Your transfer transaction is being processed",
    }),
    parseErrorTxNotification: () => ({
      title: "Transfer transaction failed",
      description: "",
    }),
  };

  const transparentTransaction = useTransaction({
    eventType: "TransparentTransfer",
    createTxAtom: createTransparentTransferAtom,
    params: [{ data: [{ source, target, token, amount: txAmount }] }],
    ...commomProps,
  });

  const shieldedTransaction = useTransaction({
    eventType: "ShieldedTransfer",
    createTxAtom: createShieldedTransferAtom,
    params: [{ data: [{ source, target, token, amount: txAmount }] }],
    ...commomProps,
  });

  const shieldingTransaction = useTransaction({
    eventType: "ShieldingTransfer",
    createTxAtom: createShieldingTransferAtom,
    params: [{ target, data: [{ source, token, amount: txAmount }] }],
    ...commomProps,
  });

  const unshieldingTransaction = useTransaction({
    eventType: "UnshieldingTransfer",
    createTxAtom: createUnshieldingTransferAtom,
    params: [{ source, data: [{ target, token, amount: txAmount }] }],
    ...commomProps,
  });

  const getAddressKind = (address: Address): "Shielded" | "Transparent" =>
    isShieldedAddress(address) ? "Shielded" : "Transparent";

  const txKind: NamadaTransferTxKind =
    `${getAddressKind(source)}To${getAddressKind(target)}` as const;

  const {
    execute: performTransfer,
    gasConfig,
    isPending: isPerformingTransfer,
  } = (() => {
    switch (txKind) {
      case "TransparentToTransparent":
        return transparentTransaction;
      case "TransparentToShielded":
        return shieldingTransaction;
      case "ShieldedToTransparent":
        return unshieldingTransaction;
      case "ShieldedToShielded":
        return shieldedTransaction;
    }
  })();

  const transactionFee: TransactionFee | undefined =
    selectedAsset && gasConfig ?
      {
        originalAddress: selectedAsset.originalAddress,
        asset: selectedAsset.asset,
        amount: gasConfig.gasPrice.multipliedBy(gasConfig.gasLimit),
      }
    : undefined;

  const isSourceShielded = isShieldedAddress(source);
  const isTargetShielded = isShieldedAddress(target);

  useEffect(() => {
    if (transaction?.hash) {
      const tx = findByHash(transaction.hash);
      if (tx) {
        setTransaction(tx);
      }
    }
  }, [myTransactions]);

  const onChangeSelectedAsset = (address?: Address): void => {
    setSearchParams(
      (currentParams) => {
        const newParams = new URLSearchParams(currentParams);
        if (address) {
          newParams.set(params.asset, address);
        } else {
          newParams.delete(params.asset);
        }
        return newParams;
      },
      { replace: false }
    );
  };

  const onSubmitTransfer = async ({
    memo,
  }: OnSubmitTransferParams): Promise<void> => {
    try {
      setGeneralErrorMessage("");

      if (typeof sourceAddress === "undefined") {
        throw new Error("Source address is not defined");
      }

      if (!chainId) {
        throw new Error("Chain ID is undefined");
      }

      if (!selectedAsset) {
        throw new Error("No asset is selected");
      }

      if (typeof gasConfig === "undefined") {
        throw new Error("No gas config");
      }

      setTransaction({
        type: txKind,
        currentStep: TransferStep.Sign,
        asset: selectedAsset.asset,
        chainId,
      });

      const txResponse = await performTransfer({ memo });
      if (txResponse) {
        const txList = createTransferDataFromNamada(
          txKind,
          selectedAsset.asset,
          rpcUrl,
          txResponse,
          memo
        );

        // Currently we don't have the option of batching transfer transactions
        if (txList.length === 0) {
          throw "Couldn't create TransferData object ";
        }

        const tx = txList[0];
        setTransaction(tx);
        storeTransaction(tx);
      } else {
        throw "Invalid transaction response";
      }
    } catch (err) {
      setGeneralErrorMessage(err + "");
      setTransaction(undefined);
    }
  };

  return (
    <Panel className="relative pt-8 pb-20">
      {!transaction && (
        <div className="min-h-[600px]">
          <header className="flex flex-col items-center text-center mb-8 gap-6">
            <h1
              className={twMerge("text-lg", isSourceShielded && "text-yellow")}
            >
              Transfer
            </h1>
            <NamadaTransferTopHeader
              isSourceShielded={isSourceShielded}
              isDestinationShielded={target ? isTargetShielded : undefined}
            />
          </header>
          <TransferModule
            source={{
              isLoadingAssets,
              availableAssets,
              availableAmount: selectedAsset?.amount,
              chain: namadaChain as Chain,
              availableWallets: [wallets.namada!],
              wallet: wallets.namada,
              walletAddress: sourceAddress,
              selectedAssetAddress,
              onChangeSelectedAsset,
              isShielded: shielded,
              onChangeShielded: setShielded,
              amount: displayAmount,
              onChangeAmount: setDisplayAmount,
            }}
            destination={{
              chain: namadaChain as Chain,
              enableCustomAddress: true,
              customAddress,
              onChangeCustomAddress: setCustomAddress,
            }}
            transactionFee={transactionFee}
            isSubmitting={isPerformingTransfer}
            errorMessage={generalErrorMessage}
            onSubmitTransfer={onSubmitTransfer}
          />
        </div>
      )}
      {transaction && (
        <div
          className={clsx("absolute z-50 py-12 left-0 top-0 w-full h-full", {
            "text-yellow": shielded,
          })}
        >
          <TransferTransactionTimeline transaction={transaction} />
        </div>
      )}
    </Panel>
  );
};
