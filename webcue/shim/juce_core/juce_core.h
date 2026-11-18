#pragma once

// ---------------------------------------------------------------------------
// webcue: the slice of juce_core that SimpleCue's audio-thread code actually
// touches. CueVoice.cpp uses six JUCE names; FadeCurve.cpp adds MathConstants
// and the string helpers. Nothing here reimplements JUCE behaviour — it is a
// name-compatible shim so the real .cpp files compile verbatim, with no
// #ifdefs and no forked copies.
// ---------------------------------------------------------------------------

#include <algorithm>
#include <cassert>
#include <cstdint>
#include <initializer_list>
#include <string>
#include <vector>

#define jassert(x) assert(x)
#define JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(Class) \
    Class (const Class&) = delete;                          \
    Class& operator= (const Class&) = delete;

namespace juce
{

using int64  = std::int64_t;
using uint32 = std::uint32_t;

template <typename T> constexpr T jmin (T a, T b) { return a < b ? a : b; }
template <typename T> constexpr T jmax (T a, T b) { return a > b ? a : b; }

template <typename T, typename... Rest>
constexpr T jmin (T a, T b, Rest... rest) { return jmin (jmin (a, b), static_cast<T> (rest)...); }

template <typename T, typename... Rest>
constexpr T jmax (T a, T b, Rest... rest) { return jmax (jmax (a, b), static_cast<T> (rest)...); }

template <typename T>
constexpr T jlimit (T lower, T upper, T value)
{
    return value < lower ? lower : (upper < value ? upper : value);
}

template <typename T>
constexpr bool isPositiveAndBelow (T value, T limit)
{
    return value >= static_cast<T> (0) && value < limit;
}

template <typename T>
struct MathConstants
{
    static constexpr T pi     = static_cast<T> (3.141592653589793238L);
    static constexpr T halfPi = static_cast<T> (1.570796326794896619L);
    static constexpr T twoPi  = static_cast<T> (6.283185307179586476L);
};

//== Just enough String/StringArray for FadeCurve.cpp's name helpers ==========
class String
{
public:
    String() = default;
    String (const char* s) : text (s ? s : "") {}
    String (std::string s) : text (std::move (s)) {}

    bool operator== (const String& o) const { return text == o.text; }
    bool operator== (const char* o) const   { return text == (o ? o : ""); }

    const std::string& toStdString() const { return text; }

private:
    std::string text;
};

class StringArray
{
public:
    StringArray() = default;
    StringArray (std::initializer_list<const char*> items)
    {
        for (auto* i : items)
            strings.emplace_back (i);
    }

    int size() const { return (int) strings.size(); }
    const String& operator[] (int i) const { return strings[(size_t) i]; }

private:
    std::vector<String> strings;
};

//== Uuid: VoiceSpec carries one, but the audio thread only ever copies it ====
class Uuid
{
public:
    Uuid() = default;
    explicit Uuid (std::uint64_t v) : value (v) {}

    bool operator== (const Uuid& o) const noexcept { return value == o.value; }
    bool operator!= (const Uuid& o) const noexcept { return value != o.value; }
    bool isNull() const noexcept                   { return value == 0; }

    static Uuid null() { return Uuid(); }

    std::uint64_t value { 0 };
};

} // namespace juce
