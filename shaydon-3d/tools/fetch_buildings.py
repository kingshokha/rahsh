"""Download building footprints for Shaydon from Overture Maps (S3, GeoParquet).

Overture's building theme carries the Microsoft Global ML Building Footprints,
which cover Tajikistan far better than OpenStreetMap does today.  Only the
row groups whose bbox statistics intersect the area are read.

Usage:  AWS_CA_BUNDLE=... python3 fetch_buildings.py <cache_dir> [release]
"""
import concurrent.futures as cf
import os
import sys

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.fs as fs
import pyarrow.parquet as pq

from geo import CITY_BBOX

CACHE = sys.argv[1] if len(sys.argv) > 1 else "cache"
RELEASE = sys.argv[2] if len(sys.argv) > 2 else "2026-10-21.0"
W, S, E, N = CITY_BBOX[0] - .01, CITY_BBOX[1] - .01, CITY_BBOX[2] + .01, CITY_BBOX[3] + .01

kw = {"proxy_options": os.environ["HTTPS_PROXY"]} if os.environ.get("HTTPS_PROXY") else {}
s3 = fs.S3FileSystem(anonymous=True, region="us-west-2", **kw)
base = f"overturemaps-us-west-2/release/{RELEASE}/theme=buildings/type=building/"
files = [i.path for i in s3.get_file_info(fs.FileSelector(base))]


def scan(path):
    md = pq.ParquetFile(s3.open_input_file(path)).metadata
    idx = {md.schema.column(i).path: i for i in range(md.num_columns)}
    hits = []
    for rg in range(md.num_row_groups):
        st = lambda c: md.row_group(rg).column(idx[c]).statistics
        if st("bbox.xmin").min > E or st("bbox.xmax").max < W or st("bbox.ymin").min > N or st("bbox.ymax").max < S:
            continue
        hits.append(rg)
    return path, hits


tables = []
with cf.ThreadPoolExecutor(32) as ex:
    for path, rgs in ex.map(scan, files):
        if not rgs:
            continue
        t = pq.ParquetFile(s3.open_input_file(path)).read_row_groups(
            rgs, columns=["id", "bbox", "geometry", "height", "num_floors", "class", "names", "sources"])
        b = t.column("bbox").combine_chunks()
        m = pc.and_(pc.and_(pc.greater(b.field("xmin"), W), pc.less(b.field("xmax"), E)),
                    pc.and_(pc.greater(b.field("ymin"), S), pc.less(b.field("ymax"), N)))
        tables.append(t.filter(m))
T = pa.concat_tables(tables)
pq.write_table(T, os.path.join(CACHE, "overture_buildings.parquet"))
print(T.num_rows, "buildings")
