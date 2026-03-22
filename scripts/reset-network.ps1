Write-Host "Resetting Besu network..." -ForegroundColor Cyan

# Stop any running containers
docker compose down

# Remove old network files and node data
Remove-Item -Recurse -Force networkFiles -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force node1\data -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force node2\data -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force node3\data -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force node4\data -ErrorAction SilentlyContinue

# Recreate data folders
New-Item -ItemType Directory -Path node1\data | Out-Null
New-Item -ItemType Directory -Path node2\data | Out-Null
New-Item -ItemType Directory -Path node3\data | Out-Null
New-Item -ItemType Directory -Path node4\data | Out-Null

# Regenerate network files
besu operator generate-blockchain-config --config-file=ibftConfigFile.json --to=networkFiles --private-key-file-name=key

# Get key folder names
$keys = Get-ChildItem networkFiles\keys | Select-Object -ExpandProperty Name

# Copy keys to node data folders
Copy-Item "networkFiles\keys\$($keys[0])\key" "node1\data\key"
Copy-Item "networkFiles\keys\$($keys[1])\key" "node2\data\key"
Copy-Item "networkFiles\keys\$($keys[2])\key" "node3\data\key"
Copy-Item "networkFiles\keys\$($keys[3])\key" "node4\data\key"

# Copy genesis to node folders
Copy-Item networkFiles\genesis.json node1\genesis.json
Copy-Item networkFiles\genesis.json node2\genesis.json
Copy-Item networkFiles\genesis.json node3\genesis.json
Copy-Item networkFiles\genesis.json node4\genesis.json

# Get node1 public key - strip 0x prefix
$pubkey = (Get-Content "networkFiles\keys\$($keys[0])\key.pub" -Raw).Trim()
if ($pubkey.StartsWith("0x")) {
    $pubkey = $pubkey.Substring(2)
}

# Resolve full path to docker-compose.yml
$composePath = (Resolve-Path "docker-compose.yml").Path

# Read as raw string, collapse any previously wrapped enode lines, then replace
$content = [System.IO.File]::ReadAllText($composePath)
$content = $content -replace '(enode://[a-fA-F0-9]+)[\s\r\n]+([a-fA-F0-9]+@172\.16\.239\.11:30303)', '$1$2'
$content = $content -replace 'enode://[a-fA-F0-9]+@172\.16\.239\.11:30303', "enode://$pubkey@172.16.239.11:30303"
[System.IO.File]::WriteAllText($composePath, $content)

Write-Host "Network reset complete!" -ForegroundColor Green
Write-Host "Node1 public key: $pubkey" -ForegroundColor Yellow
Write-Host "Run 'docker compose up' to start the network." -ForegroundColor Cyan