// Runs the parity scenarios and writes the dump, so the native and WASM builds
// can be compared. Usage: parity <output.f32>

#include "scenario.h"

#include <cstdint>
#include <cstdio>

int main (int argc, char** argv)
{
    const auto samples = webcue::runAll();

    // FNV-1a over the raw bytes: a difference of one ulp in one sample changes it.
    std::uint64_t hash = 1469598103934665603ull;
    const auto* bytes = reinterpret_cast<const unsigned char*> (samples.data());

    for (size_t i = 0; i < samples.size() * sizeof (float); ++i)
    {
        hash ^= bytes[i];
        hash *= 1099511628211ull;
    }

    std::printf ("samples %zu\n", samples.size());
    std::printf ("fnv1a   %016llx\n", (unsigned long long) hash);

    if (argc > 1)
    {
        if (auto* f = std::fopen (argv[1], "wb"))
        {
            std::fwrite (samples.data(), sizeof (float), samples.size(), f);
            std::fclose (f);
        }
        else
        {
            std::fprintf (stderr, "could not open %s\n", argv[1]);
            return 1;
        }
    }

    return 0;
}
