import { useCallback, useState } from 'react';

import type { PaymentState } from './types.js';

export interface PaymentTracker {
  readonly state: PaymentState;
  readonly txHash: string | undefined;
  readonly detail: string;
  update(state: PaymentState, detail?: string): void;
  setTxHash(hash: string | undefined): void;
  reset(): void;
}

const nextPaymentDetail = (detail: string | undefined): string => detail ?? '';

export const usePaymentTracker = (): PaymentTracker => {
  const [state, setState] = useState<PaymentState>('ready');
  const [txHash, setTxHash] = useState<string | undefined>(undefined);
  const [detail, setDetail] = useState('');

  const update = useCallback((nextState: PaymentState, nextDetail?: string): void => {
    setState(nextState);
    setDetail(nextPaymentDetail(nextDetail));
  }, []);

  const reset = useCallback((): void => {
    setState('ready');
    setDetail('');
    setTxHash(undefined);
  }, []);

  return { state, txHash, detail, update, setTxHash, reset };
};
