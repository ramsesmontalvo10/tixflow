using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Ticketing.Api.Services;

namespace Ticketing.Api.Controllers;

[ApiController]
[Route("api/scanner")]
[Authorize(Roles = "staff")]
public class ScannerController(
    IScannerService scanner,
    IEd25519Signer signer) : ControllerBase
{
    private int CurrentUserId =>
        int.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? User.FindFirstValue("sub")
            ?? throw new UnauthorizedAccessException());

    // POST /api/scanner/devices
    [HttpPost("devices")]
    public async Task<IActionResult> RegisterDevice([FromBody] RegisterDeviceRequest req)
    {
        try
        {
            var deviceId = await scanner.RegisterDeviceAsync(CurrentUserId, req);
            return Ok(new { deviceId });
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { code = "DeviceRegistrationFailed", message = ex.Message });
        }
    }

    // POST /api/scanner/batches
    [HttpPost("batches")]
    public async Task<IActionResult> SubmitBatch([FromBody] SubmitBatchRequest req)
    {
        if (req.Scans is null || req.Scans.Count == 0)
            return BadRequest(new { code = "EmptyBatch" });

        try
        {
            var results = await scanner.ProcessBatchAsync(CurrentUserId, req);
            return Ok(new
            {
                deviceId = req.DeviceId,
                processed = results.Count,
                results
            });
        }
        catch (UnauthorizedAccessException)
        {
            return Forbid();
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { code = "BatchProcessingFailed", message = ex.Message });
        }
    }

    // GET /api/scanner/revocations?since=<ts>
    [HttpGet("revocations")]
    public async Task<IActionResult> GetRevocations([FromQuery] string? since)
    {
        DateTimeOffset sinceTs;
        if (string.IsNullOrWhiteSpace(since))
        {
            sinceTs = DateTimeOffset.UnixEpoch;
        }
        else if (!DateTimeOffset.TryParse(since, out sinceTs))
        {
            return BadRequest(new { code = "InvalidSince", message = "since must be an ISO 8601 timestamp." });
        }

        var revocations = await scanner.GetRevocationsSinceAsync(sinceTs);
        return Ok(new
        {
            since = sinceTs,
            count = revocations.Count,
            revocations
        });
    }

    // GET /api/scanner/public-key
    [HttpGet("public-key")]
    [AllowAnonymous]
    public IActionResult GetPublicKey()
    {
        return Ok(new
        {
            algorithm = "Ed25519",
            publicKeyBase64 = signer.GetPublicKeyBase64()
        });
    }
}