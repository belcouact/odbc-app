SELECT
    meh.event_reason AS "EVENT_REASON",
    meh.lot_number AS "WOL",
    meh.from_lot AS "LSN",
    (em.x_position + em.x_length) AS "QUANTITY",
    lm.product AS "PRODUCT",
    poh.vendor_name AS "VENDOR"
FROM mesa_event_history eh1,
     mesa_event_history meh,
     mesa_event_map em,
     mesa_lot_master lm,
     mesa_ancillary_lot_master alm,
     jde_lot_master jlm,
     jde_purchase_order_header poh,
     mesa_yield_summary mys
WHERE em.source_system_id = eh1.source_system_id
  AND em.map_control_number = eh1.control_number
  AND em.map_sequence_number = eh1.transaction_sequence
  AND em.source_system_id = meh.source_system_id
  AND em.txn_control_number = meh.control_number
  AND em.txn_sequence_number = meh.transaction_sequence
  AND meh.from_lot = lm.lot_number
  AND lm.source_system_id = alm.source_system_id
  AND lm.lot_number = alm.lot_number
  AND meh.from_lot = jlm.lot_serial_number
  AND jlm.order_number = poh.order_number(+)
  AND em.event_map_type = 'F'
  AND meh.record_status = 'AC'
  --AND meh.event_reason IN ('WFACE', 'WBACK')
  AND eh1.to_lot IS NOT NULL
  AND mys.lot_number = meh.lot_number
{}
