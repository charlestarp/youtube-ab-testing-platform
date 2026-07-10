"use client";

import useSWR from "swr";
import { useRouter } from "next/navigation";
import { auth, User } from "./api";

export function useUser() {
  const router = useRouter();
  const { data, error, isLoading, mutate } = useSWR<User>("user", auth.me, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    dedupingInterval: 5_000,
    revalidateOnMount: true,
  });

  const logout = async () => {
    await auth.logout();
    await mutate(undefined, false);
    router.push("/login");
  };

  return {
    user: data ?? null,
    isLoading,
    isError: !!error,
    isLoggedIn: !!data,
    logout,
    mutate,
  };
}
