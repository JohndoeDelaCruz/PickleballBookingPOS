import { paymentMethods } from "./finance";

export const expensesPath = "/staff/expenses";
export const expensesPageSize = 25;

export const expenseCategories = {
  supplies: "Supplies",
  utilities: "Utilities",
  maintenance: "Maintenance",
  payroll: "Payroll",
  inventory: "Inventory purchases",
  other: "Other",
} as const;

export const expensePaymentMethods = {
  cash: paymentMethods.cash,
  gcash: paymentMethods.gcash,
  bank_transfer: paymentMethods.bank_transfer,
  card: paymentMethods.card,
  other: paymentMethods.other,
} as const;

export type Expense = {
  id: string;
  expense_date: string;
  category: keyof typeof expenseCategories;
  description: string;
  amount_cents: number;
  payment_method: keyof typeof expensePaymentMethods;
  shift_id: string | null;
  shift_closed: boolean;
  voided_at: string | null;
  void_reason: string | null;
};

export type ExpenseReport = {
  total_cents: number;
  drawer_cents: number;
  row_count: number;
  rows: Expense[];
  active_shift: string | null;
};
