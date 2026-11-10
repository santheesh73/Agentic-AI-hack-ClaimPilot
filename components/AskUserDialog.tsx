"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type MissingFact = { key: string; question: string; options?: string[] };

export function AskUserDialog({
  open,
  missingFacts,
  onSubmit,
}: {
  open: boolean;
  missingFacts: MissingFact[];
  onSubmit: (answers: Record<string, string>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>A couple of quick questions</DialogTitle>
          <DialogDescription>
            These facts change whether this claim is worth appealing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {missingFacts.map((mf) => (
            <div key={mf.key} className="space-y-2">
              {mf.options?.length ? (
                // A fixed-choice question (e.g. yes / no / not sure): radios, not free text.
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">{mf.question}</legend>
                  {mf.options.map((option) => (
                    <label key={option} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={mf.key}
                        value={option}
                        checked={values[mf.key] === option}
                        onChange={() => setValues((v) => ({ ...v, [mf.key]: option }))}
                      />
                      {option}
                    </label>
                  ))}
                </fieldset>
              ) : (
                <>
                  <Label htmlFor={mf.key}>{mf.question}</Label>
                  <Input
                    id={mf.key}
                    value={values[mf.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [mf.key]: e.target.value }))}
                  />
                </>
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button
            disabled={submitting || missingFacts.some((mf) => !values[mf.key]?.trim())}
            onClick={async () => {
              setSubmitting(true);
              try {
                await onSubmit(values);
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? "Submitting…" : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
