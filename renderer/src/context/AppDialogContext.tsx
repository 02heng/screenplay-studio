import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/** 确认对话框 */
export type AppConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger：破坏性操作（删除等），主按钮红色；primary：主色强调按钮 */
  variant?: 'danger' | 'primary';
};

/** 仅提示 */
export type AppAlertOptions = {
  title?: string;
  message: string;
  okLabel?: string;
};

type PendingConfirm = {
  kind: 'confirm';
  opts: AppConfirmOptions & { confirmLabel: string; cancelLabel: string; variant: 'danger' | 'primary' };
  resolve: (v: boolean) => void;
};

type PendingAlert = {
  kind: 'alert';
  opts: AppAlertOptions & { okLabel: string };
  resolve: () => void;
};

type Pending = PendingConfirm | PendingAlert;

function defaultConfirm(opts: AppConfirmOptions): AppConfirmOptions {
  return {
    cancelLabel: '取消',
    confirmLabel: '确定',
    variant: 'danger',
    ...opts,
  };
}

export type AppDialogContextValue = {
  confirm: (options: AppConfirmOptions) => Promise<boolean>;
  /** 单行或多行文案；长文本会自动保留换行 */
  alert: (options: AppAlertOptions | string) => Promise<void>;
};

const Ctx = createContext<AppDialogContextValue | null>(null);

export function useAppDialog(): AppDialogContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppDialog must be used within AppDialogProvider');
  return v;
}

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback((options: AppConfirmOptions): Promise<boolean> => {
    const merged = defaultConfirm(options);
    return new Promise((resolve) => {
      setPending((cur) => {
        if (cur) {
          queueMicrotask(() => resolve(false));
          return cur;
        }
        return { kind: 'confirm', opts: merged, resolve };
      });
    });
  }, []);

  const alert = useCallback((options: AppAlertOptions | string): Promise<void> => {
    const opts: AppAlertOptions =
      typeof options === 'string' ? { message: options } : options;
    const full: PendingAlert['opts'] = {
      okLabel: '知道了',
      title: opts.title,
      message: opts.message,
    };
    return new Promise((resolve) => {
      setPending((cur) => {
        if (cur) {
          queueMicrotask(() => resolve());
          return cur;
        }
        return { kind: 'alert', opts: full, resolve };
      });
    });
  }, []);

  const closeConfirm = useCallback((ok: boolean) => {
    setPending((p) => {
      if (!p || p.kind !== 'confirm') return null;
      p.resolve(ok);
      return null;
    });
  }, []);

  const closeAlert = useCallback(() => {
    setPending((p) => {
      if (!p || p.kind !== 'alert') return null;
      p.resolve();
      return null;
    });
  }, []);

  const value = useMemo(() => ({ confirm, alert }), [confirm, alert]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {pending?.kind === 'confirm' ? (
        <div
          className="modal-overlay app-dialog-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="app-dialog-title"
          onClick={() => closeConfirm(false)}
        >
          <div className="modal app-dialog modal--sm" onClick={(e) => e.stopPropagation()}>
            {pending.opts.title ? (
              <h2 id="app-dialog-title" className="modal__title app-dialog__title">
                {pending.opts.title}
              </h2>
            ) : (
              <h2 id="app-dialog-title" className="modal__title app-dialog__title">
                请确认
              </h2>
            )}
            <div className="app-dialog__body">{pending.opts.message}</div>
            <div className="modal__actions app-dialog__actions">
              <button type="button" className="btn-ghost" onClick={() => closeConfirm(false)}>
                {pending.opts.cancelLabel}
              </button>
              <button
                type="button"
                className={
                  pending.opts.variant === 'primary' ? 'btn-primary' : 'btn-danger'
                }
                onClick={() => closeConfirm(true)}
              >
                {pending.opts.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {pending?.kind === 'alert' ? (
        <div
          className="modal-overlay app-dialog-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="app-dialog-alert-title"
          onClick={() => closeAlert()}
        >
          <div className="modal app-dialog modal--sm" onClick={(e) => e.stopPropagation()}>
            <h2 id="app-dialog-alert-title" className="modal__title app-dialog__title">
              {pending.opts.title ?? '提示'}
            </h2>
            <div className="app-dialog__body app-dialog__body--pre">{pending.opts.message}</div>
            <div className="modal__actions app-dialog__actions">
              <button type="button" className="btn-primary" onClick={() => closeAlert()}>
                {pending.opts.okLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Ctx.Provider>
  );
}
