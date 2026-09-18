SELECT DISTINCT
    mesa_lot_master.erp_wo_number wo,
    mesa_lot_master.split_bin_from_lot_number WOL,
    mesa_lot_master.lot_number LSN,
    mesa_lot_master.product Item,
    mesa_product_master.product_description_1 Description,
    mesa_lot_master.current_secondary_quantity Qty,
    mesa_yield_summary.FMI_DATE,
    mesa_lot_master.hold_code Code,
    mesa_table_data_master.description Reason_Description,
    jde_address_book_master.alpha_name Customer
FROM mesa_lot_master, mesa_yield_summary, mesa_move_detail, mesa_product_master,
    mesa_table_data_master, jde_address_book_master
WHERE mesa_lot_master.source_system_id = mesa_move_detail.source_system_id
    AND mesa_lot_master.current_plant = mesa_move_detail.transaction_plant
    AND mesa_lot_master.lot_number = mesa_move_detail.lot_number
    AND mesa_lot_master.current_operation = mesa_move_detail.to_operation
    AND mesa_move_detail.active_record_code = 'A'
    AND mesa_lot_master.source_system_id = mesa_product_master.source_system_id
    AND mesa_lot_master.current_plant = mesa_product_master.plant
    AND mesa_lot_master.product = mesa_product_master.product
    AND LTRIM(mesa_lot_master.customer_name) = jde_address_book_master.address_number(+)
    AND mesa_lot_master.current_plant = mesa_table_data_master.plant
    AND mesa_lot_master.hold_code = mesa_table_data_master.table_code
    AND mesa_table_data_master.table_name = 'HOLD'
    AND mesa_lot_master.current_quantity > 0
    AND mesa_lot_master.hold_code <> ' '
    AND mesa_lot_master.lot_status = 'W'
    AND mesa_lot_master.active_record_code = 'A'
    AND mesa_yield_summary.lot_number = mesa_lot_master.split_bin_from_lot_number
    AND mesa_lot_master.current_plant = 'B180'
{}
ORDER BY mesa_product_master.product_description_1, mesa_lot_master.split_bin_from_lot_number
