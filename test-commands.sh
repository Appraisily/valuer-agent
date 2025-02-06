#!/bin/bash

# Base URL - change this to match your deployment
BASE_URL="http://localhost:8080"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Testing Find Value endpoint${NC}"
curl -X POST "${BASE_URL}/api/find-value" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Antique Victorian mahogany dining table, circa 1860"
  }' | json_pp

echo -e "\n${BLUE}Testing Find Value Range endpoint${NC}"
curl -X POST "${BASE_URL}/api/find-value-range" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Antique Victorian mahogany dining table, circa 1860"
  }' | json_pp

echo -e "\n${BLUE}Testing Justify Value endpoint${NC}"
curl -X POST "${BASE_URL}/api/justify" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Antique Victorian mahogany dining table, circa 1860",
    "value": 2500
  }' | json_pp