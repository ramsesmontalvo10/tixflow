using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Security;

namespace Ticketing.Api.Services;

public interface IEd25519Signer
{
    byte[] Sign(string payload);
    bool Verify(string payload, byte[] signature);
    string GetPublicKeyBase64();
    string BuildPayload(int entradaId, long ventana);
}

public class Ed25519SignerService : IEd25519Signer
{
    private readonly Ed25519PrivateKeyParameters _privateKey;
    private readonly Ed25519PublicKeyParameters _publicKey;

    public Ed25519SignerService(IConfiguration cfg, ILogger<Ed25519Signer> logger)
    {
        var keyPath = cfg["Ed25519:PrivateKeyPath"]
            ?? Path.Combine(Directory.GetCurrentDirectory(), "data", "ed25519.key");

        if (File.Exists(keyPath))
        {
            var bytes = File.ReadAllBytes(keyPath);
            _privateKey = new Ed25519PrivateKeyParameters(bytes, 0);
            logger.LogInformation("Ed25519 private key loaded from {Path}", keyPath);
        }
        else
        {
            var random = new SecureRandom();
            _privateKey = new Ed25519PrivateKeyParameters(random);
            Directory.CreateDirectory(Path.GetDirectoryName(keyPath)!);
            File.WriteAllBytes(keyPath, _privateKey.GetEncoded());
            logger.LogWarning("Ed25519 private key GENERATED at {Path}. Not committed to git.", keyPath);
        }

        _publicKey = _privateKey.GeneratePublicKey();
        logger.LogInformation("Ed25519 public key: {Pub}", GetPublicKeyBase64());
    }

    public string BuildPayload(int entradaId, long ventana) => $"{entradaId}:{ventana}";

    public byte[] Sign(string payload)
    {
        var signer = new Org.BouncyCastle.Crypto.Signers.Ed25519Signer();
        signer.Init(true, _privateKey);
        var bytes = System.Text.Encoding.UTF8.GetBytes(payload);
        signer.BlockUpdate(bytes, 0, bytes.Length);
        return signer.GenerateSignature();
    }

    public bool Verify(string payload, byte[] signature)
    {
        var verifier = new Org.BouncyCastle.Crypto.Signers.Ed25519Signer();
        verifier.Init(false, _publicKey);
        var bytes = System.Text.Encoding.UTF8.GetBytes(payload);
        verifier.BlockUpdate(bytes, 0, bytes.Length);
        return verifier.VerifySignature(signature);
    }

    public string GetPublicKeyBase64() => Convert.ToBase64String(_publicKey.GetEncoded());
}