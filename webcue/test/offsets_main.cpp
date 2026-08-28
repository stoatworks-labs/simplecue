// Verifies that the offsets hardcoded in webcue-processor.js match the real
// WcSpec layout. Includes the engine translation unit directly so it can see
// the struct, which lives in an anonymous namespace.
//
// A silent mismatch here would corrupt every spec the browser sends, so this
// is checked rather than assumed.

#define main engine_main_unused
#include "../engine/webcue_engine.cpp"
#undef main

#include <cstddef>
#include <cstdio>

int main()
{
    std::printf ("sourceIndex        %zu\n", offsetof (WcSpec, sourceIndex));
    std::printf ("fromDeviceInput    %zu\n", offsetof (WcSpec, fromDeviceInput));
    std::printf ("inputFirstChannel  %zu\n", offsetof (WcSpec, inputFirstChannel));
    std::printf ("inputNumChannels   %zu\n", offsetof (WcSpec, inputNumChannels));
    std::printf ("regionStart        %zu\n", offsetof (WcSpec, regionStart));
    std::printf ("regionEnd          %zu\n", offsetof (WcSpec, regionEnd));
    std::printf ("preWaitSamples     %zu\n", offsetof (WcSpec, preWaitSamples));
    std::printf ("loopEnabled        %zu\n", offsetof (WcSpec, loopEnabled));
    std::printf ("loopCount          %zu\n", offsetof (WcSpec, loopCount));
    std::printf ("vampEnabled        %zu\n", offsetof (WcSpec, vampEnabled));
    std::printf ("vampStart          %zu\n", offsetof (WcSpec, vampStart));
    std::printf ("vampEnd            %zu\n", offsetof (WcSpec, vampEnd));
    std::printf ("vampRelease        %zu\n", offsetof (WcSpec, vampRelease));
    std::printf ("gain               %zu\n", offsetof (WcSpec, gain));
    std::printf ("fadeInSamples      %zu\n", offsetof (WcSpec, fadeInSamples));
    std::printf ("fadeInShape        %zu\n", offsetof (WcSpec, fadeInShape));
    std::printf ("fadeOutSamples     %zu\n", offsetof (WcSpec, fadeOutSamples));
    std::printf ("fadeOutShape       %zu\n", offsetof (WcSpec, fadeOutShape));
    std::printf ("numRoutes          %zu\n", offsetof (WcSpec, numRoutes));
    std::printf ("routeSource        %zu\n", offsetof (WcSpec, routeSource));
    std::printf ("routeOutput        %zu\n", offsetof (WcSpec, routeOutput));
    std::printf ("routeGain          %zu\n", offsetof (WcSpec, routeGain));
    std::printf ("sizeof             %zu\n", sizeof (WcSpec));
    return 0;
}
