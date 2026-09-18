"""API routes for schema discovery (tables and columns)."""
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException
import pyodbc

from app.db import odbc

router = APIRouter()


def _get_connection(connection_id: str) -> dict:
    """Look up a stored connection, raising 404 when it does not exist."""
    from app.main import get_stored_connection  # deferred to avoid import cycle

    return get_stored_connection(connection_id)


@router.get("/schema/{connection_id}/tables")
def list_tables(connection_id: str):
    """List tables and views visible through the connection."""
    conn = _get_connection(connection_id)
    try:
        return odbc.list_tables(conn)
    except pyodbc.Error as exc:
        raise HTTPException(status_code=400, detail=f"Database error: {odbc.format_db_error(exc)}") from exc


@router.get("/schema/{connection_id}/tables/{table}/columns")
def list_columns(connection_id: str, table: str):
    """List columns of a table (table name is URL-decoded by the framework)."""
    conn = _get_connection(connection_id)
    table_name = unquote(table)
    try:
        return odbc.list_columns(conn, table_name)
    except pyodbc.Error as exc:
        raise HTTPException(status_code=400, detail=f"Database error: {odbc.format_db_error(exc)}") from exc
