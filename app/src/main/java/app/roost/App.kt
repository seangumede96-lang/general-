package app.roost

import android.app.Activity
import android.app.Application
import android.os.Bundle

class App : Application(), Application.ActivityLifecycleCallbacks {
    private var started = 0

    override fun onCreate() {
        super.onCreate()
        AppLock.init(this)
        registerActivityLifecycleCallbacks(this)
    }

    override fun onActivityStarted(activity: Activity) { started++ }

    override fun onActivityStopped(activity: Activity) {
        started--
        // Nothing of ours is on screen any more (and it isn't just a rotation): lock.
        if (started == 0 && !activity.isChangingConfigurations) AppLock.onAppBackgrounded()
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityResumed(activity: Activity) {}
    override fun onActivityPaused(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}
}
