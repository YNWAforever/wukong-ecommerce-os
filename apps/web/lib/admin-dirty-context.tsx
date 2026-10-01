"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
export type AdminDirtyGuard = {
  dirty: boolean;
  save(): Promise<boolean>;
  discard(): void;
};
type DirtyContext = {
  register(key: string, guard: AdminDirtyGuard): () => void;
  hasDirty: boolean;
  saveAll(): Promise<boolean>;
  discardAll(): void;
};
const Context = createContext<DirtyContext | null>(null);
export function AdminDirtyProvider({ children }: { children: ReactNode }) {
  const guards = useRef(new Map<string, AdminDirtyGuard>());
  const [revision, setRevision] = useState(0);
  const register = useCallback((key: string, guard: AdminDirtyGuard) => {
    guards.current.set(key, guard);
    setRevision((value) => value + 1);
    return () => {
      if (guards.current.get(key) === guard) {
        guards.current.delete(key);
        setRevision((value) => value + 1);
      }
    };
  }, []);
  const value = useMemo<DirtyContext>(
    () => ({
      register,
      hasDirty: Array.from(guards.current.values()).some(
        (guard) => guard.dirty,
      ),
      async saveAll() {
        for (const guard of Array.from(guards.current.values()))
          if (guard.dirty && !(await guard.save())) return false;
        return true;
      },
      discardAll() {
        for (const guard of guards.current.values())
          if (guard.dirty) guard.discard();
      },
    }),
    [register, revision],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useAdminDirtyGuard(key: string, guard: AdminDirtyGuard) {
  const context = useContext(Context);
  const current = useRef(guard);
  current.current = guard;
  const register = context?.register;
  useEffect(
    () =>
      register?.(key, {
        dirty: guard.dirty,
        save: () => current.current.save(),
        discard: () => current.current.discard(),
      }),
    [key, guard.dirty, register],
  );
}
export function useAdminDirtyNavigation() {
  const context = useContext(Context);
  if (!context) throw new Error("Admin dirty provider required");
  return context;
}
