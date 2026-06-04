#!/usr/bin/env sh
# Assemble a self-contained static site for deployment.
# The page loads its libs from node_modules/ during local dev; for deploy we copy
# them into dist/vendor/ and rewrite the <script> paths so dist/ stands alone.
set -eu

rm -rf dist
mkdir -p dist/vendor

cp index.html style.css app.js fake_sales_data.csv dist/
cp node_modules/papaparse/papaparse.min.js dist/vendor/
cp node_modules/chart.js/dist/chart.umd.min.js dist/vendor/

sed -e 's#node_modules/papaparse/papaparse.min.js#vendor/papaparse.min.js#' \
    -e 's#node_modules/chart.js/dist/chart.umd.min.js#vendor/chart.umd.min.js#' \
    index.html > dist/index.html

echo "built dist/"
