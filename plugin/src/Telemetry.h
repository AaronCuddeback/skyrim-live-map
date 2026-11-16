#pragma once

#include "Relay.h"

namespace Telemetry
{
    void Start(const Relay::Settings& settings);
    void Stop();

    struct Rates
    {
        int playerHz;
        int actorHz;
        int maxActors;
    };
    void SetRates(int playerHz, int actorHz, int maxActors);
    Rates GetRates();
}
