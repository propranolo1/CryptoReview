using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

// 只处理 Squirrel 未能差分、因而整文件放入补丁的主程序。
// 同位置字节相减生成标准 BSDIFF40，不进行旧匹配算法的大文件后缀排序。
public static class SquirrelExecutableDelta
{
    private const string Executable = "lib/net45/CryptoReview.exe";
    private const BindingFlags StaticMethods = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;

    private static ZipArchiveEntry Find(ZipArchive zip, string name)
    {
        foreach (var entry in zip.Entries)
            if (entry.FullName.Replace('\\', '/').Equals(name, StringComparison.OrdinalIgnoreCase)) return entry;
        return null;
    }

    private static string Hash(string file, bool sha1 = false)
    {
        using (var algorithm = sha1 ? (HashAlgorithm)SHA1.Create() : SHA256.Create())
        using (var stream = File.OpenRead(file))
            return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }

    private static void Extract(string package, string target)
    {
        using (var zip = ZipFile.OpenRead(package))
        {
            var entry = Find(zip, Executable);
            if (entry == null) throw new InvalidDataException("安装包缺少主程序");
            entry.ExtractToFile(target);
        }
    }

    private static Stream Compress(Assembly squirrel, Stream output)
    {
        // 使用当前打包器内置的 BZip2 编码器，保持旧 Squirrel 解码兼容性。
        var modeType = squirrel.GetType("SharpCompress.Compressors.CompressionMode", true);
        var streamType = squirrel.GetType("SharpCompress.Compressors.BZip2.BZip2Stream", true);
        var constructor = streamType.GetConstructor(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
            null, new[] { typeof(Stream), modeType, typeof(bool), typeof(bool) }, null);
        return (Stream)constructor.Invoke(new[] { output, Enum.Parse(modeType, "Compress"), true, false });
    }

    private static void ReadExactly(Stream stream, byte[] buffer, int count)
    {
        int offset = 0;
        while (offset < count)
        {
            int read = stream.Read(buffer, offset, count - offset);
            if (read == 0) throw new EndOfStreamException("主程序在生成补丁时发生变化");
            offset += read;
        }
    }

    private static void CreatePatch(Assembly squirrel, string source, string target, string patch)
    {
        using (var oldFile = File.OpenRead(source))
        using (var newFile = File.OpenRead(target))
        using (var output = File.Create(patch))
        using (var writer = new BinaryWriter(output))
        {
            long common = Math.Min(oldFile.Length, newFile.Length);
            long extra = newFile.Length - common;
            writer.Write(Encoding.ASCII.GetBytes("BSDIFF40"));
            writer.Write(0L);
            writer.Write(0L);
            writer.Write(newFile.Length);
            // BSDIFF40 控制段：(叠加差值的长度，新增数据长度，旧文件跳转量)。
            using (var compressed = Compress(squirrel, output))
            using (var control = new BinaryWriter(compressed))
            {
                control.Write(common);
                control.Write(extra);
                control.Write(0L);
            }
            long controlEnd = output.Position;
            var oldBytes = new byte[128 * 1024];
            var newBytes = new byte[oldBytes.Length];
            using (var compressed = Compress(squirrel, output))
            {
                for (long position = 0; position < common;)
                {
                    int count = (int)Math.Min(oldBytes.Length, common - position);
                    ReadExactly(oldFile, oldBytes, count);
                    ReadExactly(newFile, newBytes, count);
                    for (int i = 0; i < count; i++) newBytes[i] = unchecked((byte)(newBytes[i] - oldBytes[i]));
                    compressed.Write(newBytes, 0, count);
                    position += count;
                }
            }
            long diffEnd = output.Position;
            // 旧版解码器会打开空的新增段，但其编码器压缩空输入会除零。
            // 因此空段写入标准 BZip2 空流（BZh9、结束标记、零 CRC）。
            if (extra == 0)
                writer.Write(new byte[] { 0x42, 0x5a, 0x68, 0x39, 0x17, 0x72, 0x45, 0x38, 0x50, 0x90, 0, 0, 0, 0 });
            else
                using (var compressed = Compress(squirrel, output)) newFile.CopyTo(compressed);
            output.Position = 8;
            writer.Write(controlEnd - 32);
            writer.Write(diffEnd - controlEnd);
        }
    }

    private static void VerifyPatch(Assembly squirrel, string source, string patch, string target, string restored)
    {
        // 使用发布包内原版 Squirrel 解码器验证，不能由同一套自写代码自证正确。
        var apply = squirrel.GetType("Squirrel.Bsdiff.BinaryPatchUtility", true).GetMethod("Apply", StaticMethods);
        using (var oldFile = File.OpenRead(source))
        using (var output = File.Create(restored))
            apply.Invoke(null, new object[] { oldFile, new Func<Stream>(() => File.OpenRead(patch)), output });
        if (new FileInfo(restored).Length != new FileInfo(target).Length || Hash(restored) != Hash(target))
            throw new InvalidDataException("主程序补丁还原校验失败，停止发布");
    }

    private static void AddText(ZipArchive zip, string name, string text)
    {
        using (var stream = zip.CreateEntry(name, CompressionLevel.Optimal).Open())
        {
            var bytes = Encoding.UTF8.GetBytes(text);
            stream.Write(bytes, 0, bytes.Length);
        }
    }

    public static bool Repair(string baseline, string full, string delta, string squirrelPath, string work)
    {
        long compressedSize;
        using (var zip = ZipFile.OpenRead(delta))
        {
            var entry = Find(zip, Executable);
            if (entry == null) return false;
            compressedSize = entry.CompressedLength;
            entry.ExtractToFile(Path.Combine(work, "target.exe"));
        }
        string source = Path.Combine(work, "source.exe");
        string target = Path.Combine(work, "target.exe");
        string expected = Path.Combine(work, "expected.exe");
        string patch = Path.Combine(work, "executable.bsdiff");
        Extract(baseline, source);
        Extract(full, expected);
        if (Hash(target) != Hash(expected)) throw new InvalidDataException("差分包与完整包的主程序不一致");
        var squirrel = Assembly.LoadFrom(squirrelPath);
        CreatePatch(squirrel, source, target, patch);
        // 运行时大幅变化时差值未必更小，保留原有整文件回退。
        if (new FileInfo(patch).Length + 1024 >= compressedSize) return false;
        VerifyPatch(squirrel, source, patch, target, Path.Combine(work, "restored.exe"));

        string replacement = Path.Combine(work, "replacement.nupkg");
        File.Copy(delta, replacement);
        using (var zip = ZipFile.Open(replacement, ZipArchiveMode.Update))
        {
            foreach (string suffix in new[] { "", ".diff", ".bsdiff", ".shasum" })
            {
                var entry = Find(zip, Executable + suffix);
                if (entry != null) entry.Delete();
            }
            zip.CreateEntryFromFile(patch, Executable + ".bsdiff", CompressionLevel.Optimal);
            // 与 Squirrel 自身的 BSDIFF 产物一致：过旧的解码器读到占位符会转用完整包。
            AddText(zip, Executable + ".diff", "1");
            // 旧版 Squirrel 按字符串比较 SHA-1，校验文件必须使用其原有的大写格式。
            AddText(zip, Executable + ".shasum", Hash(target, true).ToUpperInvariant() + " CryptoReview.exe.shasum " + new FileInfo(target).Length);
        }
        // 临时目录与产物在同一磁盘，校验成功后才原子替换，失败保留原文件。
        File.Replace(replacement, delta, null);
        return true;
    }
}
