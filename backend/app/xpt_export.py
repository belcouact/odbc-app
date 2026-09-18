"""SAS Version 5 Transport (XPT) writer — powers the "JMP" export button.

JMP opens SAS Transport (``.xpt``) files natively, so exporting query results
in this format gives engineers a one-click path into JMP with data types
preserved. The SAS v5 transport format is open, stable (unchanged since the
1980s) and fully documented (SAS Technical Support document TS-140), so it is
implemented here in pure Python with no third-party dependencies — keeping the
offline single-EXE desktop bundle unchanged.

Layout notes (all records are 80 bytes, padded with spaces):

* Library header, then one member:
  * member header + one 140-byte variable descriptor per column (streamed and
    padded to 80-byte records) + observation header + row data.
* Numeric values are stored as IBM-style hex floats (sign, 7-bit base-16
  exponent, 56-bit mantissa); the SAS missing value is ``b'.' + 7 NULs``.
* Character values are fixed-width, padded with spaces.
"""

import math
import struct
from datetime import datetime
from typing import Callable, Optional, Sequence

import pandas as pd

XPT_MEDIA_TYPE = "application/x-sas-transport"

_NAMESTR_STRUCT = struct.Struct(">hhhh8s40s8shhh2s8shhl52s")
_NUMERIC = 1  # SAS numeric type code in a namestr record
_CHARACTER = 2  # SAS character type code in a namestr record

_LIBRARY_TEMPLATE = (
    "HEADER RECORD" + "*******" + "LIBRARY HEADER RECORD" + "!!!!!!!" + "0" * 30 + "  "
    + "SAS     SAS     SASLIB  "
    + "%(version)8b%(os)8b" + " " * 24 + "%(created)16b"
    + "%(modified)16b" + " " * 64
    + "%(members)b"
).encode("ascii")

_MEMBER_TEMPLATE = (
    "HEADER RECORD" + "*******" + "MEMBER  HEADER RECORD" + "!!!!!!!" + "0" * 17 + "16" + "0" * 8 + "140  "
    + "HEADER RECORD" + "*******" + "DSCRPTR HEADER RECORD" + "!!!!!!!" + "0" * 30 + "  "
    + "SAS     %(name)8bSASDATA %(version)8b%(os)8b" + " " * 24 + "%(created)16b"
    + "%(modified)16b" + " " * 16 + "%(label)40b%(type)8b"
    + "HEADER RECORD" + "*******" + "NAMESTR HEADER RECORD" + "!!!!!!!" + "0" * 6 + "%(n_variables)04d" + "0" * 20 + "  "
    + "%(namestrs)b"
    + "HEADER RECORD" + "*******" + "OBS     HEADER RECORD" + "!!!!!!!" + "0" * 30 + "  "
).encode("ascii")


def _ibm_float(value: object) -> bytes:
    """Encode a Python float in IBM hex-float format (8 bytes).

    IEEE 754 doubles are converted to the IBM representation used by XPT.
    ``None``/NaN/Inf are written as the SAS missing value; values outside the
    representable IBM range are also treated as missing rather than failing.
    """
    if value is None:
        return b"." + b"\x00" * 7
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return b"." + b"\x00" * 7
    value = float(value)
    if value == 0.0:
        return b"\x00" * 8
    bits = struct.pack(">d", value)
    ulong, = struct.unpack(">Q", bits)

    sign = (ulong >> 63) & 1
    exponent = ((ulong & (0x7FF << 52)) >> 52) - 1023
    mantissa = ulong & 0x000FFFFFFFFFFFFF
    # IBM range: |value| in ~ 16**-65 .. 16**63.
    if exponent > 248 or exponent < -260:
        return b"." + b"\x00" * 7

    # IBM mantissa has an implicit 0 before the radix point; IEEE has an
    # implicit 1, so set that bit and compensate in the exponent.
    mantissa = 0x0010000000000000 | mantissa
    quotient, remainder = divmod(exponent, 4)  # 16**x == 2**(4x)
    mantissa <<= remainder
    exponent = quotient + 1 + 64  # excess-64 base-16 exponent

    sign <<= 63
    exponent <<= 56
    return struct.pack(">Q", sign | exponent | mantissa)


def _encode_datetime(value: Optional[datetime] = None) -> bytes:
    """Encode a datetime in the XPT ``ddMMMyy:HH:MM:SS`` format."""
    value = value or datetime.now()
    return value.strftime("%d%b%y:%H:%M:%S").upper().encode("ascii")


def _pad(value: str, width: int) -> bytes:
    """Encode text as ASCII padded to ``width`` bytes (left-justified)."""
    return value.encode("ascii", "replace").ljust(width)


def _column_names(columns: Sequence[str]) -> tuple[list[str], list[str]]:
    """Map long column names to the 8-char limit of SAS v5.

    The XPT variable-name field is 8 bytes, so longer names are truncated
    (with a numeric suffix when truncation collides). The full original name
    is kept in the 40-byte label field so JMP users can still see it.
    """
    names: list[str] = []
    labels: list[str] = []
    used: set[str] = set()
    for column in columns:
        full = str(column)
        base = full[:8].strip() or "X"
        name = base
        counter = 1
        while name in used:
            suffix = str(counter)
            name = base[: 8 - len(suffix)] + suffix
            counter += 1
        used.add(name)
        names.append(name)
        labels.append(full[:40])
    return names, labels


def _encode_observations(df: pd.DataFrame, specs: list[tuple[int, int]]) -> bytes:
    """Encode every row as one fixed-width observation, padded to 80 bytes."""
    encoders: list[tuple[int, Callable[[object], bytes]]] = []
    for column, (vtype, length) in zip(df.columns, specs):
        if vtype == _NUMERIC:
            encoders.append((length, _ibm_float))
        else:

            def encoder(value: object, _length: int = length) -> bytes:
                if value is None or (isinstance(value, float) and math.isnan(value)):
                    return b" " * _length
                return str(value).encode("utf-8").ljust(_length)

            encoders.append((length, encoder))

    records = []
    for row in df.itertuples(index=False):
        chunks = []
        for value, (length, encode) in zip(row, encoders):
            chunks.append(encode(value))
        records.append(b"".join(chunks))
    observations = b"".join(records)
    if len(observations) % 80:
        observations += b" " * (80 - len(observations) % 80)
    return observations


def dataframe_to_xpt(df: pd.DataFrame, dataset_name: str = "DATA") -> bytes:
    """Serialize a pandas DataFrame to a complete XPT transport file.

    Numeric and boolean columns become IBM-float numeric columns; everything
    else (strings, datetimes, mixed objects) becomes fixed-width character
    columns. Returns the raw bytes, ready to stream to the client.
    """
    names, labels = _column_names(list(df.columns))

    specs: list[tuple[int, int]] = []
    for column in df.columns:
        dtype = df[column].dtype
        if pd.api.types.is_bool_dtype(dtype) or pd.api.types.is_numeric_dtype(dtype):
            specs.append((_NUMERIC, 8))
        else:
            length = 1
            for value in df[column].tolist():
                if value is None or (isinstance(value, float) and math.isnan(value)):
                    continue
                length = max(length, len(str(value).encode("utf-8")))
            specs.append((_CHARACTER, length))

    namestrs = bytearray()
    position = 0
    for number, (name, label, (vtype, length)) in enumerate(
        zip(names, labels, specs), start=1
    ):
        namestrs += _NAMESTR_STRUCT.pack(
            vtype,
            0,  # hash of name — always 0
            length,
            number,
            _pad(name, 8),
            _pad(label, 40),
            b" " * 8,  # format name (none)
            0, 0, 0,  # format length / decimals / justify
            b"",  # unused alignment bytes
            b" " * 8,  # informat name (none)
            0, 0,  # informat length / decimals
            position,  # byte position of the value in an observation
            b"",  # reserved
        )
        position += length
    if len(namestrs) % 80:
        namestrs += b" " * (80 - len(namestrs) % 80)

    created = _encode_datetime()
    member = _MEMBER_TEMPLATE % {
        b"name": _pad(dataset_name[:8], 8),
        b"version": _pad("V5", 8),
        b"os": _pad("WIN", 8),
        b"created": created,
        b"modified": created,
        b"label": _pad("", 40),
        b"type": b"DATA".rjust(8),  # SAS right-justifies the dataset type
        b"n_variables": len(specs),
        b"namestrs": bytes(namestrs),
    }
    member += _encode_observations(df, specs)

    return _LIBRARY_TEMPLATE % {
        b"version": _pad("V5", 8),
        b"os": _pad("WIN", 8),
        b"created": created,
        b"modified": created,
        b"members": member,
    }
