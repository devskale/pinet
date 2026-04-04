#!/bin/bash
# Start pi as "Master" agent
export PINET_AGENT_NAME=Master
cd "$(dirname "$0")"
pi
