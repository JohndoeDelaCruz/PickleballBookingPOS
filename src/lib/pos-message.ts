const updatedMessages = new Map(Object.entries({
  "Open your cashier shift before collecting payments.": "Open your register shift before collecting payments.",
  "Open your cashier shift and refresh before recording a drawer expense.": "Open your register shift and refresh before recording a drawer expense.",
  "This register or cashier already has an open shift.": "There’s already an open shift for this register or account.",
  "Choose a confirmed account with the Cashier role.": "Choose a confirmed account with the Front Desk Staff role.",
  "Another cashier is assigned to the register today.": "Another front desk staff member is assigned to the register today.",
}));

export function posMessage(message: string) {
  return updatedMessages.get(message) ?? message;
}
