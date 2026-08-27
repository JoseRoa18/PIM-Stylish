-- The UI's workflow vocabulary (workflowStatus.js: new / audit / in_review /
-- re_launch / ready_to_sell / archived) was never fully added to the enum —
-- bulk status changes to "Ready to Sell" failed with
--   invalid input value for enum product_workflow_status: "ready_to_sell".
-- Add the missing values (additive, existing rows untouched). The legacy
-- labels (draft / update / published / discontinued) remain valid; statusMeta
-- renders them gracefully.
-- APPLIED live 2026-08-20 via the management API; this file documents it.

alter type public.product_workflow_status add value if not exists 'in_review';
alter type public.product_workflow_status add value if not exists 'ready_to_sell';
alter type public.product_workflow_status add value if not exists 'archived';
