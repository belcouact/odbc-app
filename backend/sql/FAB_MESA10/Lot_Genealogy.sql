SELECT
    mesa_event_history.event_reason,
    mesa_event_history.lot_number,
    mesa_event_history.from_lot,
    em.x_position + em.x_length,
    lm.product,
    poh.vendor_name
FROM mesa_event_history eh1, mesa_event_history, mesa_event_map em, mesa_lot_master lm,
    mesa_ancillary_lot_master, jde_lot_master jlm, jde_purchase_order_header poh, mesa_yield_summary mys
WHERE em.source_system_id = eh1.source_system_id
    AND em.map_control_number = eh1.control_number
    AND em.map_sequence_number = eh1.transaction_sequence
    AND em.source_system_id = mesa_event_history.source_system_id
    AND em.txn_control_number = mesa_event_history.control_number
    AND em.txn_sequence_number = mesa_event_history.transaction_sequence
    AND mesa_event_history.from_lot = lm.lot_number
    AND lm.source_system_id = mesa_ancillary_lot_master.source_system_id
    AND lm.lot_number = mesa_ancillary_lot_master.lot_number
    AND mesa_event_history.from_lot = jlm.lot_serial_number
    AND jlm.order_number = poh.order_number(+)
    AND em.event_map_type = 'F'
    AND mesa_event_history.record_status = 'AC'
    AND mesa_event_history.event_reason IN ('WFACE','WBACK')
    AND eh1.to_lot IS NOT NULL
    AND mys.lot_number = mesa_event_history.lot_number
    AND mesa_event_history.plant = 'B180'
{}
