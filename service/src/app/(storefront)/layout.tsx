import { StoreShell } from "@/components/shell/store-shell";
import { InstallDialog } from "@/components/storefront/install-dialog";

/**
 * Storefront chrome: the 248px rail belongs to the public catalog and product pages
 * only. Dashboard and moderation keep their own console frame.
 */
export default function StorefrontLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <StoreShell>
      {children}
      <InstallDialog />
    </StoreShell>
  );
}
