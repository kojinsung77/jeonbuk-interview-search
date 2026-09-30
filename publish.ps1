param([string]$Remote = 'origin')
$ErrorActionPreference = 'Stop'
$repoConfig = @('-c', ('safe.directory=' + $PSScriptRoot))
Push-Location $PSScriptRoot
try {
    $badFiles = Get-ChildItem -LiteralPath 'public' -File -Recurse | Where-Object {
        $_.Extension -in @('.pdf', '.xlsx', '.csv', '.zip', '.log', '.txt') -or
        ($_.Extension -eq '.json' -and $_.Name -ne 'meta.json') -or
        $_.Name -like '.writing-*'
    }
    if ($badFiles) { throw '평문 자료 또는 임시 파일이 배포 폴더에 있습니다. 게시를 중단합니다.' }
    if (-not (Test-Path -LiteralPath 'public/data/cases.bin')) { throw '먼저 build.py를 실행하세요.' }
    node --check public/app.js
    if ($LASTEXITCODE -ne 0) { throw 'JavaScript 구문 검사 실패' }
    git @repoConfig add -- public build.py requirements.txt README.md publish.ps1 .gitignore .gitattributes
    if ($LASTEXITCODE -ne 0) { throw 'Git stage 실패' }
    git @repoConfig diff --cached --quiet
    if ($LASTEXITCODE -eq 1) {
        git @repoConfig commit -m 'Update encrypted interview library'
        if ($LASTEXITCODE -ne 0) { throw 'Git commit 실패' }
    }
    git @repoConfig push $Remote HEAD
    if ($LASTEXITCODE -ne 0) { throw '소스 업로드 실패' }
    git @repoConfig fetch $Remote gh-pages
    if ($LASTEXITCODE -ne 0) { throw '기존 Pages 브랜치 확인 실패' }
    $publicTree = git @repoConfig rev-parse HEAD:public
    if ($LASTEXITCODE -ne 0) { throw '배포 폴더 확인 실패' }
    $pagesParent = git @repoConfig rev-parse FETCH_HEAD
    $pagesCommit = git @repoConfig commit-tree $publicTree.Trim() -p $pagesParent.Trim() -m 'Publish encrypted interview library'
    if ($LASTEXITCODE -ne 0) { throw 'Pages 배포 준비 실패' }
    $pagesRef = $pagesCommit.Trim() + ':refs/heads/gh-pages'
    git @repoConfig push $Remote $pagesRef
    if ($LASTEXITCODE -ne 0) { throw 'Pages 업로드 실패' }
    Write-Output '게시 업로드 완료. GitHub Pages 빌드 결과를 확인하세요.'
} finally { Pop-Location }
