SELECT
  rsc.transaction_code as Transaction_Code,
  rsc.event_start_date as Event_Start_Date,
  dt.new_code as Reason_Code,
  rsc.process_step as Process_Step,
  dt.status as Status,
  rsc.plant as Plant,
  rsc.mes_resource as MES_Resource,
  rsc.elapsed_time_minutes as DT_MINS,
  dt.description as Description,
  dt.CHAR04 as Event_Group,
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
