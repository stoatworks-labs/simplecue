// Isolates the fade curves from the voice: evaluates all five shapes across a
// dense sweep of t and dumps the results, so a native/WASM difference can be
// attributed to the curve maths rather than to anything in CueVoice.

#include "Model/FadeCurve.h"

#include <cstdint>
#include <cstdio>
#include <vector>

int main (int argc, char** argv)
{
    const cp::FadeShape shapes[] = { cp::FadeShape::linear,
                                     cp::FadeShape::equalPower,
                                     cp::FadeShape::exponential,
                                     cp::FadeShape::logarithmic,
                                     cp::FadeShape::sCurve };

    const char* names[] = { "linear", "equalPower", "exponential", "logarithmic", "sCurve" };

    constexpr int steps = 100000;

    for (int s = 0; s < 5; ++s)
    {
        std::uint64_t hash = 1469598103934665603ull;

        for (int i = 0; i <= steps; ++i)
        {
            const float t = (float) ((double) i / (double) steps);
            const float g = cp::evaluateFadeIn (shapes[s], t);

            const auto* bytes = reinterpret_cast<const unsigned char*> (&g);

            for (size_t b = 0; b < sizeof (float); ++b)
            {
                hash ^= bytes[b];
                hash *= 1099511628211ull;
            }
        }

        std::printf ("%-12s %016llx\n", names[s], (unsigned long long) hash);
    }

    return 0;
}
