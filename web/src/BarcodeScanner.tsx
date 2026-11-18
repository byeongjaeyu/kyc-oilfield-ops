import { useEffect, useRef, useState } from 'react';

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];

interface Detector {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}

/** 휴대폰 카메라로 바코드 읽기. 브라우저가 기본 지원하지 않으면(아이폰 등) 읽기 엔진을 그때 불러옴 */
async function makeDetector(): Promise<Detector> {
  const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
  if (Native) {
    try {
      return new Native({ formats: FORMATS });
    } catch {
      /* 지원 형식이 달라 실패하면 아래로 */
    }
  }
  const { BarcodeDetector } = await import('barcode-detector/ponyfill');
  return new BarcodeDetector({ formats: FORMATS as never }) as unknown as Detector;
}

/**
 * 카메라 미리보기 + 손으로 입력 (블루투스·USB 바코드 리더는 키보드처럼 입력하고 Enter)
 * 읽으면 onCode 를 한 번 부르고 멈춤. 다시 찍으려면 "다시 찍기"
 */
export function BarcodeScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'starting' | 'scanning' | 'found' | 'nocam'>('starting');
  const [error, setError] = useState('');
  const [typed, setTyped] = useState('');
  const [round, setRound] = useState(0);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (stopped) return;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
        const detector = await makeDetector();
        setState('scanning');
        const tick = async () => {
          if (stopped) return;
          try {
            if (v.readyState >= 2) {
              const found = await detector.detect(v);
              const code = found.find((f) => f.rawValue)?.rawValue;
              if (code) {
                stopped = true;
                navigator.vibrate?.(60);
                setState('found');
                stream?.getTracks().forEach((t) => t.stop());
                onCode(code.trim());
                return;
              }
            }
          } catch {
            /* 한 프레임 실패는 무시 */
          }
          timer = window.setTimeout(tick, 220);
        };
        tick();
      } catch (e) {
        setState('nocam');
        setError(
          (e as Error).name === 'NotAllowedError'
            ? '카메라 권한이 막혀 있습니다. 브라우저 주소창의 자물쇠에서 카메라를 허용하거나, 아래에 바코드 숫자를 직접 넣으세요.'
            : '카메라를 열지 못했습니다. 아래에 바코드 숫자를 직접 넣으세요.',
        );
      }
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round]);

  return (
    <div className="scanner" role="dialog" aria-label="바코드 찍기">
      <div className="scanner-view">
        <video ref={videoRef} playsInline muted aria-hidden />
        {state === 'scanning' && <span className="scanner-line" aria-hidden />}
        {state !== 'scanning' && (
          <p className="scanner-msg">
            {state === 'starting' ? '카메라 여는 중…' : state === 'found' ? '읽었습니다' : error}
          </p>
        )}
      </div>
      <form
        className="copy-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) {
            onCode(typed.trim());
            setTyped('');
          }
        }}
      >
        <input inputMode="numeric" placeholder="바코드 숫자 (리더기로 찍어도 됨)" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="바코드 직접 입력" />
        <button type="submit" className="primary">
          확인
        </button>
      </form>
      <div className="form-actions">
        {state === 'found' && (
          <button type="button" className="more" onClick={() => (setState('starting'), setRound((r) => r + 1))}>
            다시 찍기
          </button>
        )}
        <button type="button" className="link-btn" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}
