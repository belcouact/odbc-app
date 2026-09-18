SELECT DISTINCT
    gm_batch.TO_LOT AS 'WOL',
    gm_wol.PRODUCT AS 'Product',
    gm_batch.EVENT_REASON AS 'BOM',
    gm_batch.ITEM_NUMBER AS 'Raw_item',
    gm_batch.G_BATCH AS 'Gore_batch',
    gm_batch.FROM_LOT AS 'Raw_lot',
    ROUND(gm_batch.PRIMARY_QTY, 1) AS 'Raw_lot_qty',
    gm_batch.GM_OPERATION AS 'Raw_issue_step',
    gm_batch.CHANGED_ON AS 'Raw_issue_date',
    g_lsn.G_SUPPLIER_BATCH AS 'Supplier_batch',
    g_lsn.G_SUPPLIER_PIECE AS 'Supplier_piece',
    g_lsn.G_PURCHASE_ORDER_NO AS 'Supplier_PO'
FROM GM_BATCH gm_batch
LEFT JOIN G_LSN g_lsn ON gm_batch.FROM_LOT = g_lsn.NAME
LEFT JOIN GM_WOL gm_wol ON gm_wol.G_WOL = gm_batch.TO_LOT
WHERE 1 = 1
    AND gm_batch.EVENT_REASON IN ('WFACE','WFILM','WBACK')
{}
