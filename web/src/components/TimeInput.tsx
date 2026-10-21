import { useEffect, useState } from 'react';
import { formatHms, formatSrtTime, parseTime } from '@wve/shared';

interface Props {
  valueMs: number;
  onCommit: (ms: number) => void;
  /** hms — чч:мм:сс, srt — чч:мм:сс,ммм */
  format?: 'hms' | 'srt';
  className?: string;
  title?: string;
}

/** Поле ввода времени: правка как текст, применение по Enter или потере фокуса. */
export function TimeInput({ valueMs, onCommit, format = 'srt', className, title }: Props) {
  const fmt = format === 'hms' ? formatHms : formatSrtTime;
  const [text, setText] = useState(fmt(valueMs));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(fmt(valueMs));
    setInvalid(false);
  }, [valueMs, fmt]);

  const commit = () => {
    const ms = parseTime(text);
    if (ms === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (ms !== valueMs) onCommit(ms);
    else setText(fmt(valueMs));
  };

  return (
    <input
      className={`time-input mono ${invalid ? 'invalid' : ''} ${className ?? ''}`}
      value={text}
      title={title}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(fmt(valueMs));
          setInvalid(false);
        }
      }}
    />
  );
}
