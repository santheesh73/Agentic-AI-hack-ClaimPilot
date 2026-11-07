"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col flex-1 items-center justify-center gap-4 p-8 text-center">
      <p className="text-lg font-medium">Something went wrong</p>
      <p className="text-muted-foreground text-sm max-w-md">
        An unexpected error occurred. This has not affected any saved case data.
      </p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
        <Button asChild>
          <Link href="/">Back to start</Link>
        </Button>
      </div>
    </div>
  );
}
