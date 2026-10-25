"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { jsonRequest } from "@/lib/http-client";

/** Ends the admin session and returns to the login page. */
export function AdminSignOut({ base }: { base: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    await jsonRequest("/api/admin/session", "DELETE");
    router.replace(`${base}/login`);
    router.refresh();
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={signOut}
      disabled={pending}
      className="h-7 px-2 text-xs"
    >
      <LogOut className="size-3.5" aria-hidden />
      退出
    </Button>
  );
}
