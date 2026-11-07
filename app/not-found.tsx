import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center gap-4 p-8 text-center">
      <p className="text-lg font-medium">Page not found</p>
      <p className="text-muted-foreground text-sm">The page you&apos;re looking for doesn&apos;t exist.</p>
      <Button asChild>
        <Link href="/">Back to start</Link>
      </Button>
    </div>
  );
}
