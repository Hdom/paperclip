param(
 [ValidateSet('GET','PATCH','PUT','POST')][string]$Method='GET',
 [Parameter(Mandatory=$true)][string]$ApiPath,
 [string]$BodyFile,
 [switch]$ConfirmChange,
 [switch]$ValidateOnly,
 [string]$ValidationApiBase='https://example.invalid/api'
)
# This flag prevents accidental writes. It does not replace user/tool approval.
$company='/companies/[a-f0-9-]{36}'
$valid=($ApiPath -eq '/companies' -and $Method -eq 'GET') -or
 ($ApiPath -match ('^'+$company+'$') -and $Method -in @('GET','PATCH')) -or
 ($ApiPath -match ('^'+$company+'/github-project-apps$') -and $Method -in @('GET','PUT')) -or
 ($ApiPath -match ('^'+$company+'/github-project-apps/(verify|migrate)$') -and $Method -eq 'POST') -or
 ($ApiPath -match '^/secrets/[a-f0-9-]{36}$' -and $Method -eq 'GET')
if (-not $valid -or ($Method -ne 'GET' -and -not $ConfirmChange)) {throw 'Unsupported endpoint or missing explicit change flag'}
$apiBase=if($ValidateOnly){$ValidationApiBase}else{[Environment]::GetEnvironmentVariable('PAPERCLIP_OPERATOR_API_URL','User')}
$uri=[Uri]$apiBase
if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath.TrimEnd('/') -ne '/api') {throw 'Expected an authorized HTTPS API origin without embedded credentials'}
if ($ValidateOnly) {@{validated=$true;method=$Method;path=$ApiPath;networkRequests=0} | ConvertTo-Json;return}
Add-Type -AssemblyName System.Net.Http
$safe='id,name,status,companyId,isInstanceAdmin,source,available,canManage,enabled,revision,roles,blockedAgentIds,checkedAt,migration,migrated,cleanupPending,role,agentId,appId,installationId,installationUrl,appUrl,login,message,repositories,publicFingerprint,keyStorage,secretId,pinnedVersion,latestVersion,keyStatus,fullName,repositoryId,owner,error,code,scope,provider,version,createdAt,updatedAt,key'.Split(',')
function SelectSafeMetadata($value) {
 if ($null -eq $value) {return $null}
 if ($value -is [array]) {return ,@($value | ForEach-Object {SelectSafeMetadata $_})}
 if ($value -is [pscustomobject]) {$result=[ordered]@{};foreach($property in $value.PSObject.Properties){if($property.Name -in $safe){$result[$property.Name]=SelectSafeMetadata $property.Value}};return $result}
 return $value
}
try {
 $token=[Environment]::GetEnvironmentVariable('PAPERCLIP_OPERATOR_API_TOKEN','User')
 if (-not $token) {throw 'Operator credential missing'}
 $handler=[System.Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false
 # Keep native certificate and hostname validation; no validation callback.
 $client=[System.Net.Http.HttpClient]::new($handler);$client.Timeout=[TimeSpan]::FromSeconds(45)
 $request=[System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method),$apiBase.TrimEnd('/')+$ApiPath)
 $request.Headers.Authorization=[System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$token)
 if($BodyFile){$body=Get-Content -LiteralPath $BodyFile -Raw -ErrorAction Stop;$null=$body | ConvertFrom-Json -ErrorAction Stop;if($body -match '"(privateKey|password|token|connectionString)"\s*:'){throw 'Secret values are not supported in operator settings requests'};$request.Content=[System.Net.Http.StringContent]::new($body,[Text.Encoding]::UTF8,'application/json')}
 $response=$client.SendAsync($request).GetAwaiter().GetResult()
 $text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult();$result=$text | ConvertFrom-Json -ErrorAction Stop
 @{httpStatus=[int]$response.StatusCode;result=(SelectSafeMetadata $result)} | ConvertTo-Json -Depth 15
 if(-not $response.IsSuccessStatusCode){exit 1}
} catch {Write-Error 'Operator API request failed; no credential or response body is disclosed';exit 1}
finally {if($request){$request.Dispose()};if($client){$client.Dispose()}}
