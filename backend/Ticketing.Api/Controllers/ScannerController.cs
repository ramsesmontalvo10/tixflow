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

    // GET /api/scanner/events
    [HttpGet("events")]
    public async Task<IActionResult> GetAssignedEvents()
    {
        return Ok(await scanner.GetAssignedEventsAsync(CurrentUserId));
    }

    // POST /api/scanner/devices
    [HttpPost("devices")]
    public async Task<IActionResult> RegisterDevice([FromBody] RegisterDeviceRequest req)
    {
        try
        {
            var deviceId = await scanner.RegisterDeviceAsync(CurrentUserId, req);
            return Ok(new { deviceId });
        }
        catch (UnauthorizedAccessException)
        {
            return Forbid();
        }
        catch (KeyNotFoundException ex)
        {
            return NotFound(new { code = "ScannerResourceNotFound", message = ex.Message });
        }
        catch (InvalidOperationException ex)
        {
            return Conflict(new { code = "EventUnavailable", message = ex.Message });
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
        catch (KeyNotFoundException ex)
        {
            return NotFound(new { code = "ScannerResourceNotFound", message = ex.Message });
        }
        catch (InvalidOperationException ex)
        {
            return Conflict(new { code = "EventUnavailable", message = ex.Message });
        }
    }

    // GET /api/scanner/revocations?eventId=<id>&since=<ts>
    [HttpGet("revocations")]
    public async Task<IActionResult> GetRevocations(
        [FromQuery] int eventId,
        [FromQuery] string? since)
    {
        if (eventId <= 0)
        {
            return BadRequest(new { code = "InvalidEventId" });
        }

        DateTimeOffset sinceTs;
        if (string.IsNullOrWhiteSpace(since))
        {
            sinceTs = DateTimeOffset.UnixEpoch;
        }
        else if (!DateTimeOffset.TryParse(since, out sinceTs))
        {
            return BadRequest(new { code = "InvalidSince", message = "since must be an ISO 8601 timestamp." });
        }

        try
        {
            var (syncedAt, revocations) =
                await scanner.GetRevocationsSinceAsync(CurrentUserId, eventId, sinceTs);
            return Ok(new
            {
                since = sinceTs,
                syncedAt,
                count = revocations.Count,
                revocations
            });
        }
        catch (UnauthorizedAccessException)
        {
            return Forbid();
        }
        catch (KeyNotFoundException ex)
        {
            return NotFound(new { code = "ScannerResourceNotFound", message = ex.Message });
        }
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