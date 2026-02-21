import { useCallback, useRef, useState } from 'react';

export interface InputManager {
  readonly input: string;
  readonly setInput: React.Dispatch<React.SetStateAction<string>>;
  readonly inputHistory: readonly string[];
  readonly historyOffsetRef: React.MutableRefObject<number>;
  readonly savedDraftRef: React.MutableRefObject<string>;
  pushToHistory(text: string): void;
}

export const appendToInputHistory = (
  history: readonly string[],
  text: string,
): readonly string[] => [...history.slice(-99), text];

export const useInputManager = (): InputManager => {
  const [input, setInput] = useState('');
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const historyOffsetRef = useRef(0);
  const savedDraftRef = useRef('');

  const pushToHistory = useCallback((text: string): void => {
    setInputHistory((prev) => [...appendToInputHistory(prev, text)]);
    historyOffsetRef.current = 0;
  }, []);

  return { input, setInput, inputHistory, historyOffsetRef, savedDraftRef, pushToHistory };
};
