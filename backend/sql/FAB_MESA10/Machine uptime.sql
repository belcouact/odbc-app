SELECT
  rsc.transaction_code,
  rsc.event_start_date,
  dt.new_code reason_code,
  rsc.process_step,
  dt.status,
  rsc.plant,
  rsc.mes_resource,
  rsc.elapsed_time_minutes DT_MINS,
  dt.description,
  dt.CHAR04 event_group
FROM
  mesa_rsc_downtime rsc,
  v_fab_mesa_dt_codes dt,
  mesa_resource_master rm
WHERE
  rm.RESOURCE_TYPE = 'MACHINE'
  AND rsc.source_system_id = dt.source_system_id
  AND rsc.plant = dt.plant
  AND rsc.plant = rm.plant
  AND rm.RESOURCE_ID = rsc.MES_RESOURCE
  and rm.resource_subtype in ('LAMINATION','DWR','COATER','SLITTER')
  AND rsc.reason_code = dt.old_code
  AND dt.status <> 'NOPRODUCTION'
  {}
