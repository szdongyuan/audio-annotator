import type { AppError } from '../../bridge/types';

// Planning is read-only. Stop waiting for an unavailable NAS without starting a write.
export function awaitPreview<T>(request: Promise<T>, signal: AbortSignal, timeoutMs = 20000): Promise<T> {
    return new Promise((resolve, reject) => {
        const finish = (callback: () => void) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            callback();
        };
        const abort = () => finish(() => reject({code:'Cancelled', message:'已停止读取导出目录', retryable:true} satisfies AppError));
        const timer = setTimeout(() => finish(() => reject({code:'ResourceLimit', message:'读取导出目录超时，请检查共享目录连接后重试。', retryable:true} satisfies AppError)), timeoutMs);
        signal.addEventListener('abort', abort, {once:true});
        if (signal.aborted) abort();
        request.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
}
