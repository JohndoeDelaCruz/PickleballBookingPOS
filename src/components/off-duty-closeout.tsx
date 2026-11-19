"use client";

import { useState } from "react";
import type { Shift } from "@/lib/pos";
import { RegisterShiftDialog } from "./register-day";
import { useAnimatedModal } from "./use-animated-modal";

export function OffDutyCloseout({ shift, operator }: { shift: Shift; operator: string }) {
  const [open, setOpen, closing] = useAnimatedModal<true>();
  const [closed, setClosed] = useState(false);

  return <>
    {!closed && <p className="account-link">
      <button type="button" className="button button-outline button-small" onClick={() => setOpen(true)}>
        Close your open register shift
      </button>
    </p>}
    {open && <RegisterShiftDialog shift={shift} operator={operator} closing={closing} onClose={() => setOpen(null)}
      onSaved={() => { setClosed(true); setOpen(null); }} />}
  </>;
}
